import crypto from 'crypto';
import type { CloudSyncProgress, SyncDirection, SyncIndexEntry, SyncSessionState, SyncShareRow } from 'deveye-types';
import type { Logger } from 'pino';
import type { Database } from '../db';
import type { MonitorHub } from '../agent/hub';
import { BlobHashMismatchError, type ShareBlobStore } from './blobStore';
import { compileExclusions } from './exclusions';
import { makeBucket, type TokenBucket } from './rateLimit';
import {
    planSession,
    type Plan,
    type PlanConflict,
    type PlanFile,
    type PlanModeChange,
    type PlanMove
} from './planner';
import { normalizeRelPath, relPathHash, relPathProblem } from './pathValidation';
import { archiveBlobAsVersion, archiveCurrent } from './versions';

/**
 * Une session de synchro pour UNE paire (partage, appareil), exécutée sous le
 * mutex du partage (voir engine.ts). Machine à états :
 *
 *   scanning → planning → transferring → done | error | cancelled
 *
 * Chaque étape est atomique et re-exécutable : une session interrompue
 * n'importe où laisse au pire des fichiers temporaires (balayés) et des
 * versions déjà archivées — relancer converge. L'ordre des écritures est la
 * garantie anti-perte :
 *   upload    : blob vérifié → archive de l'ancien → index → baseline ;
 *   download  : opResult ok de l'agent → baseline ;
 *   deletion  : archive → index `deleted` → baseline ; côté appareil, l'ordre
 *               est vérifié AVANT l'envoi (une version doit exister).
 */

/** Un événement agent routé vers la session (corrélé par sessionId/opId). */
export type AgentSyncEvent =
    | { type: 'index'; entries: SyncIndexEntry[]; done: boolean; error?: string }
    | { type: 'chunk'; data: string; done: boolean; hash?: string; size?: number; mtime?: number; error?: string }
    | { type: 'ack'; seq: number }
    | {
          type: 'opResult';
          op: 'apply' | 'applyDir' | 'applyLocal' | 'applyReady' | 'delete' | 'move' | 'push';
          ok: boolean;
          /** `applyReady` seulement : octets de clair déjà détenus par l'agent. */
          resumeFrom?: number;
          error?: string;
      };

/** Ce que la session attend de son hôte (le moteur) — interface volontairement étroite. */
export interface SessionHost {
    readonly db: Database;
    readonly hub: MonitorHub;
    readonly logger: Logger;
    /** Corrèle les événements agent entrants vers cette session. */
    claimOp(opId: string, deviceId: string, push: (ev: AgentSyncEvent) => void): void;
    releaseOp(opId: string): void;
    /** Publie la progression aux abonnés web (et la met en cache pour les snapshots). */
    publishProgress(progress: CloudSyncProgress): void;
    /** Le plan est connu : l'état agrégé du partage peut être réévalué. */
    onPlanned(): void;
}

/** File d'événements consommée séquentiellement, avec timeout d'inactivité. */
class EventQueue {
    private readonly queue: AgentSyncEvent[] = [];
    private resolver: ((ev: AgentSyncEvent) => void) | null = null;

    push(ev: AgentSyncEvent): void {
        if (this.resolver) {
            const r = this.resolver;
            this.resolver = null;
            r(ev);
        } else {
            this.queue.push(ev);
        }
    }

    next(timeoutMs: number): Promise<AgentSyncEvent> {
        const queued = this.queue.shift();
        if (queued) return Promise.resolve(queued);
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.resolver = null;
                reject(new Error('Agent silencieux (délai dépassé)'));
            }, timeoutMs);
            timer.unref();
            this.resolver = (ev) => {
                clearTimeout(timer);
                resolve(ev);
            };
        });
    }
}

const OP_TIMEOUT_MS = 60_000;
const PROGRESS_PUBLISH_MS = 250;
const PROGRESS_PERSIST_MS = 2_000;
/** Fraîcheur de la relecture de l'état de pause (partage + appareil). */
const PAUSE_CHECK_TTL_MS = 750;
/** Chunks `sync.applyChunk` en vol au maximum (crédit d'acks). */
const DOWNLOAD_WINDOW = 4;
/** Au-delà, une session sans travail est tout de même montrée (gros scan). */
const VISIBLE_AFTER_MS = 3_000;

/**
 * Le fichier a bougé sous nos pieds entre le scan et la lecture. Distinguée
 * d'une simple erreur parce qu'elle seule (avec un hash final non conforme)
 * justifie de DÉTRUIRE le partiel : les octets reçus ne mènent nulle part.
 */
class ContentChangedError extends Error {
    constructor() {
        super('Fichier modifié pendant le transfert');
    }
}

class SessionAbort extends Error {
    constructor(
        readonly outcome: 'cancelled' | 'error',
        message: string
    ) {
        super(message);
    }
}

export class SyncSession {
    private readonly sessionId = crypto.randomUUID();
    private sessionRowId = 0;
    private state: SyncSessionState = 'scanning';
    private filesTotal = 0;
    private bytesTotal = 0;
    private filesDone = 0;
    private bytesDone = 0;
    private currentPath: string | null = null;
    /** Avancement DANS le fichier en cours (0/0 quand il n'y en a pas). */
    private currentBytes = 0;
    private currentTotal = 0;
    private direction: SyncDirection | null = null;
    private lastPublish = 0;
    private lastPersist = 0;
    private lastPauseCheck = 0;
    private aborted: SessionAbort | null = null;
    private readonly failures: string[] = [];
    /** L'index serveur a changé : le moteur re-planifie les AUTRES appareils. */
    private serverChanged = false;
    /**
     * hash → un chemin où l'appareil possédait DÉJÀ ce contenu au début de la
     * session. C'est ce qui transforme un déplacement en copie locale plutôt
     * qu'en re-téléchargement. Rempli au moment du plan.
     */
    private baselineByHash = new Map<string, string>();
    /**
     * Chemins que ce plan va faire disparaître de l'appareil. Croisé avec
     * {@link baselineByHash}, c'est ce qui distingue un DÉPLACEMENT (le contenu
     * quitte un chemin pour un autre : on renomme) d'une simple copie (il reste
     * aux deux endroits). Sans cette distinction, un déplacement laissait une
     * copie intégrale dans la corbeille de chaque pair.
     */
    private movedAway = new Set<string>();
    private readonly startedAt = Date.now();
    /**
     * Plafond de débit des DESCENTES ; `null` = illimité (le défaut). Les
     * montées sont bridées par l'agent, qui en est l'émetteur — brider ici ne
     * ferait que gonfler les tampons intermédiaires sans ralentir la source.
     */
    private readonly downBucket: TokenBucket | null;

    constructor(
        private readonly host: SessionHost,
        private readonly share: SyncShareRow,
        private readonly deviceId: string,
        private readonly store: ShareBlobStore
    ) {
        this.downBucket = makeBucket(share.rate_down_bps);
    }

    /** Interrompt la session dès la prochaine frontière sûre (fin d'op en cours). */
    abort(outcome: 'cancelled' | 'error', message: string): void {
        this.aborted ??= new SessionAbort(outcome, message);
    }

    /** Vrai si la session a modifié l'index canonique (uploads, suppressions, conflits). */
    get changedServer(): boolean {
        return this.serverChanged;
    }

    /**
     * Cette session mérite-t-elle d'être MONTRÉE comme « synchronisation en
     * cours » ?
     *
     * Un scan à vide dure une fraction de seconde et ne change rien. L'annoncer
     * faisait clignoter le badge du partage à chaque déclenchement du watcher —
     * du bruit permanent pour un état qui, lui, n'a pas bougé. On n'annonce donc
     * que s'il y a du vrai travail, ou si le scan dure assez longtemps pour que
     * se taire deviendrait mensonger.
     */
    get isVisible(): boolean {
        return this.filesTotal > 0 || Date.now() - this.startedAt > VISIBLE_AFTER_MS;
    }

    /**
     * Le plan est-il connu ? Tant qu'il ne l'est pas (scan en cours), `isVisible`
     * ne peut pas encore trancher, et l'état publié ne doit pas être figé.
     */
    get planned(): boolean {
        return this.state !== 'scanning';
    }

    /** Écrit une ligne dans le journal du partage (popup « Logs »), sans juger la session. */
    private logEvent(relPath: string | null, message: string): void {
        void this.host.db.syncEvents
            .insert({ shareId: this.share.id, deviceId: this.deviceId, relPath, message })
            .catch(() => undefined);
    }

    /** Consigne un échec par fichier : compteur de session + journal du partage. */
    private recordFailure(relPath: string | null, message: string): void {
        if (relPath !== null) this.failures.push(relPath);
        this.logEvent(relPath, message);
    }

    /**
     * Consigne une anomalie rattrapée : journalisée, mais la session reste un
     * succès (rien n'est resté en plan, la convergence a eu lieu autrement).
     */
    private recordNotice(relPath: string | null, message: string): void {
        this.logEvent(relPath, message);
    }

    /** Exécute la session de bout en bout. Ne lève jamais : l'issue est persistée. */
    async run(): Promise<void> {
        const { db, logger } = this.host;
        const row = await db.syncSessions.create(this.share.id, this.deviceId);
        this.sessionRowId = row.id;
        try {
            const index = await this.scan();
            const plan = await this.plan(index);
            await this.transfer(plan);
            const outcome = this.failures.length > 0 ? 'error' : 'done';
            const error =
                this.failures.length > 0
                    ? `${this.failures.length} fichier(s) non synchronisé(s) : ${this.failures.slice(0, 3).join(', ')}`
                    : null;
            await this.finish(outcome, error);
            if (outcome === 'done') await db.syncShares.touchDeviceSynced(this.share.id, this.deviceId);
        } catch (err) {
            const abort = err instanceof SessionAbort ? err : null;
            const message = abort?.message ?? (err instanceof Error ? err.message : String(err));
            if (!abort)
                logger.error({ err, shareId: this.share.id, deviceId: this.deviceId }, 'CloudSync session failed');
            if (abort?.outcome !== 'cancelled') this.recordFailure(null, `Session interrompue : ${message}`);
            await this.finish(abort?.outcome ?? 'error', message).catch(() => undefined);
        }
    }

    // ─── Étape 1 : scan ────────────────────────────────────────────────────────

    private async scan(): Promise<SyncIndexEntry[]> {
        this.setState('scanning');
        const queue = new EventQueue();
        this.host.claimOp(this.sessionId, this.deviceId, (ev) => queue.push(ev));
        try {
            const sent = this.host.hub.requestSyncScan(this.deviceId, {
                sessionId: this.sessionId,
                shareId: this.share.id
            });
            if (!sent) throw new SessionAbort('error', 'Agent hors ligne');

            const entries = new Map<string, SyncIndexEntry>();
            /** Chemins vus deux fois dans CE scan (voir plus bas) : écartés. */
            const duplicated = new Set<string>();
            for (;;) {
                this.checkAbort();
                const ev = await queue.next(OP_TIMEOUT_MS);
                if (ev.type !== 'index') continue; // Frame parasite : ignorée.
                if (ev.error) throw new SessionAbort('error', `Scan impossible : ${ev.error}`);
                for (const entry of ev.entries) {
                    // Défense en profondeur : l'agent a déjà filtré, on revalide.
                    const problem = relPathProblem(entry.relPath);
                    if (problem !== null) {
                        this.recordFailure(entry.relPath, `Fichier non synchronisable : ${problem}`);
                        continue;
                    }
                    const normalized = normalizeRelPath(entry.relPath);
                    // Deux fichiers DISTINCTS sur le disque peuvent produire le
                    // même chemin « wire » : « café.txt » en NFC et le même en
                    // NFD coexistent sur ext4 et se normalisent pareil. Prendre
                    // le dernier arrivé ferait osciller la synchro d'un cycle à
                    // l'autre. On écarte les deux et on le dit dans le journal.
                    if (entries.has(normalized)) duplicated.add(normalized);
                    entries.set(normalized, { ...entry, relPath: normalized });
                }
                if (ev.done) break;
                if (entries.size > 5_000_000) {
                    throw new SessionAbort('error', 'Scan démesuré (plus de 5 M de fichiers)');
                }
            }
            for (const relPath of duplicated) {
                entries.delete(relPath);
                this.recordFailure(
                    relPath,
                    'Deux fichiers locaux portent ce même nom à la normalisation Unicode près (NFC/NFD) — aucun des deux n’est synchronisé'
                );
            }
            return [...entries.values()];
        } finally {
            this.host.releaseOp(this.sessionId);
        }
    }

    // ─── Étape 2 : plan ────────────────────────────────────────────────────────

    private async plan(deviceIndex: SyncIndexEntry[]): Promise<Plan> {
        this.setState('planning');
        const { db } = this.host;
        const excluded = compileExclusions(await db.syncShares.listExclusions(this.share.id));
        const baseline = await db.syncFiles.listBaseline(this.share.id, this.deviceId);
        // Les chemins exclus (même ajoutés après coup) et les chemins non
        // portables sont invisibles au merge : ni propagés, ni téléchargés, ni
        // supprimés. Le filtre DOIT être symétrique (index serveur ET scan
        // appareil), sinon un chemin retiré d'un seul côté serait aussitôt
        // ressuscité par l'autre.
        const hidden = (relPath: string): boolean => excluded(relPath) || relPathProblem(relPath) !== null;
        const server = (await db.syncFiles.listByShare(this.share.id)).filter((r) => !hidden(r.rel_path));
        const device = deviceIndex.filter((e) => !hidden(e.relPath));

        const plan = planSession(device, baseline, server);
        for (const skip of plan.skipped) this.recordFailure(skip.relPath, skip.reason);

        // Ce que l'appareil a déjà sous la main, indexé par contenu. Seuls les
        // chemins encore présents dans le scan comptent : une baseline qui ne
        // correspond plus à rien sur le disque ferait échouer la copie locale.
        this.movedAway = new Set(plan.deleteOnDevice.filter((f) => f.kind !== 'dir').map((f) => f.relPath));
        const scanned = new Set(device.map((e) => e.relPath));
        this.baselineByHash = new Map(
            baseline
                .filter((b) => b.kind !== 'dir' && scanned.has(b.rel_path))
                .map((b) => [b.hash, b.rel_path] as const)
        );

        this.filesTotal = plan.filesTotal;
        this.bytesTotal = plan.bytesTotal;
        await this.persistProgress(true);
        // Le plan vient d'être arrêté : c'est MAINTENANT qu'on sait s'il y a du
        // travail, donc maintenant que l'état agrégé mérite d'être republié.
        // Sans ça, un vrai transfert n'apparaissait qu'au bout de trois secondes.
        this.host.onPlanned();
        return plan;
    }

    // ─── Étape 3 : transferts ──────────────────────────────────────────────────

    private async transfer(plan: Plan): Promise<void> {
        this.setState('transferring');
        const { db } = this.host;

        // L'ORDRE compte dès que des dossiers entrent dans l'index :
        //  - à la descente, les dossiers d'abord (un fichier a besoin de son
        //    parent — même si l'install les crée, un dossier VIDE attendu ne
        //    doit pas être balayé ensuite) ;
        //  - à la suppression, les fichiers d'abord, les dossiers ensuite (on ne
        //    met pas un dossier à la corbeille avec son contenu encore dedans).
        const dirsFirst = (a: PlanFile, b: PlanFile): number =>
            a.kind === b.kind ? a.relPath.localeCompare(b.relPath) : a.kind === 'dir' ? -1 : 1;
        const filesFirst = (a: PlanFile, b: PlanFile): number => -dirsFirst(a, b);

        for (const file of plan.uploads) {
            await this.guardedStep(file.relPath, 'up', () => this.uploadFromDevice(file, 'overwrite'));
        }
        for (const conflict of plan.conflicts) {
            const direction = conflict.winner === 'device' ? 'up' : 'down';
            await this.guardedStep(conflict.server.relPath, direction, () => this.resolveConflict(conflict));
        }
        for (const file of [...plan.downloads].sort(dirsFirst)) {
            await this.guardedStep(file.relPath, 'down', () => this.downloadToDevice(file));
        }
        for (const change of plan.modeChanges) {
            await this.guardedStep(change.file.relPath, change.target === 'server' ? 'up' : 'down', () =>
                this.applyModeChange(change)
            );
        }
        // AVANT les suppressions : un déplacement doit être reconnu comme tel,
        // pas exécuté par ses deux moitiés.
        for (const move of plan.moves) {
            await this.guardedStep(move.to.relPath, 'up', () => this.applyMove(move));
        }
        for (const file of [...plan.deleteOnServer].sort(filesFirst)) {
            await this.guardedStep(file.relPath, 'delete', () => this.deleteOnServer(file));
        }
        for (const file of [...plan.deleteOnDevice].sort(filesFirst)) {
            await this.guardedStep(file.relPath, 'delete', () => this.deleteOnDevice(file));
        }

        for (const file of plan.refreshBaseline) {
            await this.writeBaseline(file);
        }
        for (const relPath of plan.dropBaseline) {
            await db.syncFiles.deleteBaseline(this.share.id, this.deviceId, relPathHash(relPath));
        }
    }

    /** Écrit la baseline de cet appareil pour une entrée déjà en phase. */
    private writeBaseline(file: PlanFile, mode: number | null = file.mode): Promise<void> {
        return this.host.db.syncFiles.upsertBaseline({
            shareId: this.share.id,
            deviceId: this.deviceId,
            relPath: file.relPath,
            relPathHash: relPathHash(file.relPath),
            kind: file.kind,
            hash: file.hash,
            size: file.size,
            mtime: file.mtime,
            mode
        });
    }

    /**
     * Applique un `chmod` seul : aucun octet ne transite, seul le mode change.
     * Un fichier rendu exécutable sur une machine le devient partout.
     */
    private async applyModeChange(change: PlanModeChange): Promise<void> {
        const { file, mode } = change;
        if (change.target === 'server') {
            await this.host.db.syncFiles.setMode(this.share.id, relPathHash(file.relPath), mode);
            this.serverChanged = true;
        } else {
            await this.sendApplyMeta({ ...file, mode });
        }
        await this.writeBaseline(file, mode);
        await this.fileDone(0);
    }

    /** Un pas de plan : pause/offline vérifiés avant, échec isolé (la session continue). */
    private async guardedStep(relPath: string, direction: SyncDirection, step: () => Promise<void>): Promise<void> {
        this.checkAbort();
        await this.checkPaused();
        this.currentPath = relPath;
        this.direction = direction;
        await this.publishProgress();
        try {
            await step();
        } catch (err) {
            if (err instanceof SessionAbort) throw err;
            this.host.logger.warn(
                { err, shareId: this.share.id, deviceId: this.deviceId, relPath },
                'CloudSync step failed'
            );
            this.recordFailure(relPath, err instanceof Error ? err.message : String(err));
        }
        this.currentPath = null;
        this.direction = null;
    }

    /** Upload appareil → blob store, puis archive de l'ancien contenu + index + baseline. */
    private async uploadFromDevice(file: PlanFile, archiveReason: 'overwrite' | 'conflict'): Promise<void> {
        const { db } = this.host;

        // Un dossier vide n'a pas de contenu : rien à remonter, juste une ligne.
        // Et un contenu que le blob store possède DÉJÀ (renommage, déplacement,
        // copie, fichier revenu d'une version) n'a aucune raison de retraverser
        // le réseau : le CAS garantit que le blob de ce hash EST ce contenu.
        // Déplacer un dossier de 5 Go ne coûte donc plus un octet de montée.
        const local = file.kind === 'dir' || (await this.store.has(file.hash));
        const { received, mtime } = local
            ? { received: { hash: file.hash, size: file.size }, mtime: file.mtime }
            : await this.pullBlobFromDevice(file);

        const pathHash = relPathHash(file.relPath);
        const existing = await db.syncFiles.getByRelPathHash(this.share.id, pathHash);
        if (existing && existing.state === 'present' && existing.kind !== 'dir' && existing.hash !== received.hash) {
            await archiveCurrent(db, this.store, existing, archiveReason);
        }
        await db.syncFiles.upsert({
            shareId: this.share.id,
            relPath: file.relPath,
            relPathHash: pathHash,
            kind: file.kind,
            hash: received.hash,
            size: received.size,
            mtime,
            mode: file.mode,
            sourceDeviceId: this.deviceId
        });
        this.serverChanged = true;
        await this.writeBaseline({ ...file, hash: received.hash, size: received.size, mtime });
        await this.fileDone(received.size);
    }

    /**
     * Résout un conflit selon la politique du partage. Dans les deux cas, AUCUN
     * des deux contenus n'est perdu :
     *  - `newest` : le perdant est archivé comme version (reason `conflict`) ;
     *  - `rename` : le perdant reste VIVANT sous un nom « (conflit …) » qui se
     *    propage à tous les appareils comme n'importe quel fichier.
     */
    private async resolveConflict(conflict: PlanConflict): Promise<void> {
        const rename = this.share.conflict_policy === 'rename';
        if (conflict.winner === 'device') {
            if (rename) {
                // Le contenu serveur perdant survit sous le nom de conflit (son
                // blob est déjà dans le CAS) avant que l'upload ne l'écrase.
                await this.insertConflictCopy(conflict.server, null);
            }
            // L'ancien contenu serveur est aussi archivé en version par l'upload.
            await this.uploadFromDevice(conflict.device, 'conflict');
            return;
        }
        // Le serveur gagne : la copie appareil perdante est d'abord remontée…
        const { received, mtime } = await this.pullBlobFromDevice(conflict.device);
        if (rename) {
            // …et reste vivante sous le nom de conflit (redescendra partout).
            await this.insertConflictCopy(
                { ...conflict.device, hash: received.hash, size: received.size, mtime },
                this.deviceId
            );
        } else {
            // …et est archivée comme version consultable/restaurable.
            await archiveBlobAsVersion(this.host.db, this.store, {
                shareId: this.share.id,
                relPath: conflict.device.relPath,
                hash: received.hash,
                size: received.size,
                mtime,
                sourceDeviceId: this.deviceId,
                reason: 'conflict'
            });
        }
        this.bytesDone += received.size;
        // Puis le contenu serveur gagnant remplace la copie locale.
        await this.downloadToDevice(conflict.server);
    }

    /** Insère le perdant d'un conflit comme NOUVEAU fichier vivant « (conflit …) ». */
    private async insertConflictCopy(file: PlanFile, sourceDeviceId: string | null): Promise<void> {
        const conflictPath = await this.uniqueConflictPath(file.relPath);
        await this.host.db.syncFiles.upsert({
            shareId: this.share.id,
            relPath: conflictPath,
            relPathHash: relPathHash(conflictPath),
            kind: file.kind,
            hash: file.hash,
            size: file.size,
            mtime: file.mtime,
            mode: file.mode,
            sourceDeviceId
        });
        this.serverChanged = true;
    }

    /** `docs/rapport.pdf` → `docs/rapport (conflit 2026-07-02 14-05-33).pdf`, unique. */
    private async uniqueConflictPath(relPath: string): Promise<string> {
        const slash = relPath.lastIndexOf('/');
        const dir = slash === -1 ? '' : relPath.slice(0, slash + 1);
        const name = slash === -1 ? relPath : relPath.slice(slash + 1);
        const dot = name.lastIndexOf('.');
        const stem = dot <= 0 ? name : name.slice(0, dot);
        const ext = dot <= 0 ? '' : name.slice(dot);
        const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ').replaceAll(':', '-');
        for (let n = 0; ; n += 1) {
            const suffix = n === 0 ? '' : ` ${n + 1}`;
            const candidate = `${dir}${stem} (conflit ${stamp}${suffix})${ext}`;
            const existing = await this.host.db.syncFiles.getByRelPathHash(this.share.id, relPathHash(candidate));
            if (!existing) return candidate;
        }
    }

    /**
     * Fait remonter un fichier de l'appareil dans le blob store, vérifié par
     * hash. Si le fichier a changé entre le scan et la lecture (hash final
     * différent de l'annonce), le transfert est jeté — la prochaine session
     * (déclenchée par le watcher) le reprendra.
     */
    private async pullBlobFromDevice(
        file: PlanFile
    ): Promise<{ received: { hash: string; size: number }; mtime: number }> {
        const opId = crypto.randomUUID();
        const queue = new EventQueue();
        this.host.claimOp(opId, this.deviceId, (ev) => queue.push(ev));
        // Le store rend le partiel déjà en place pour ce hash : on ne redemande
        // que ce qui manque. Un fichier modifié depuis a un autre hash, donc un
        // autre partiel — aucune reprise sur des octets périmés n'est possible.
        const writer = await this.store.openWrite(file.hash);
        const startOffset = writer.resumeFrom;
        let succeeded = false;
        try {
            if (startOffset > 0) {
                this.recordNotice(
                    file.relPath,
                    `Transfert repris à ${Math.round((startOffset / Math.max(1, file.size)) * 100)} % (${startOffset} octets déjà reçus)`
                );
            }
            const sent = this.host.hub.requestSyncPush(this.deviceId, {
                opId,
                shareId: this.share.id,
                relPath: file.relPath,
                startOffset
            });
            if (!sent) throw new SessionAbort('error', 'Agent hors ligne');

            this.beginFile(file.relPath, file.size, startOffset);
            let mtime = file.mtime;
            for (;;) {
                const ev = await queue.next(OP_TIMEOUT_MS);
                if (ev.type !== 'chunk') continue;
                if (ev.error) throw new Error(`Lecture impossible sur l'appareil : ${ev.error}`);
                if (ev.data.length > 0) {
                    const bytes = Buffer.from(ev.data, 'base64');
                    await writer.write(bytes);
                    await this.advance(bytes.length);
                }
                if (ev.done) {
                    if (ev.hash !== undefined && ev.hash !== file.hash) {
                        throw new ContentChangedError();
                    }
                    if (ev.mtime !== undefined) mtime = ev.mtime;
                    break;
                }
            }
            // `finalize` vérifie le SHA-256 du clair reçu contre l'annonce du scan.
            const received = await writer.finalize();
            succeeded = true;
            return { received, mtime };
        } catch (err) {
            // Une coupure (agent hors ligne, pause, silence) doit LAISSER le
            // partiel en place : c'est tout l'intérêt de la reprise. Seule une
            // incohérence de CONTENU le rend inexploitable et le détruit.
            const corrupt = err instanceof BlobHashMismatchError || err instanceof ContentChangedError;
            await (corrupt ? writer.abort() : writer.suspend()).catch(() => undefined);
            throw err;
        } finally {
            if (!succeeded) this.endFile();
            this.host.releaseOp(opId);
        }
    }

    /**
     * Pose les métadonnées d'un chemin sans transférer un octet. Sert aux deux
     * seuls cas où il n'y a pas de contenu à déplacer : créer un dossier VIDE de
     * l'index, et appliquer un `chmod` seul (sur un fichier comme sur un
     * dossier — l'agent ne crée le chemin que s'il manque).
     */
    private async sendApplyMeta(file: PlanFile): Promise<void> {
        const opId = crypto.randomUUID();
        const queue = new EventQueue();
        this.host.claimOp(opId, this.deviceId, (ev) => queue.push(ev));
        try {
            const sent = this.host.hub.requestSyncApplyDir(this.deviceId, {
                opId,
                shareId: this.share.id,
                relPath: file.relPath,
                kind: file.kind,
                mode: file.mode
            });
            if (!sent) throw new SessionAbort('error', 'Agent hors ligne');
            for (;;) {
                const ev = await queue.next(OP_TIMEOUT_MS);
                if (ev.type !== 'opResult') continue;
                if (!ev.ok) throw new Error(ev.error ?? 'Création de dossier refusée par l’agent');
                return;
            }
        } finally {
            this.host.releaseOp(opId);
        }
    }

    /**
     * Tente le RENOMMAGE local : le contenu quitte un chemin pour un autre sur
     * l'appareil. Ni transfert, ni corbeille. Un échec n'est pas grave — le
     * serveur retombe sur le chemin ordinaire, qui reste sûr.
     */
    private async tryMove(file: PlanFile, fromRelPath: string): Promise<boolean> {
        const opId = crypto.randomUUID();
        const queue = new EventQueue();
        this.host.claimOp(opId, this.deviceId, (ev) => queue.push(ev));
        try {
            const sent = this.host.hub.requestSyncMove(this.deviceId, {
                opId,
                shareId: this.share.id,
                fromRelPath,
                relPath: file.relPath,
                hash: file.hash,
                size: file.size,
                mtime: file.mtime,
                mode: file.mode
            });
            if (!sent) throw new SessionAbort('error', 'Agent hors ligne');
            for (;;) {
                const ev = await queue.next(OP_TIMEOUT_MS);
                if (ev.type !== 'opResult') continue;
                return ev.ok;
            }
        } finally {
            this.host.releaseOp(opId);
        }
    }

    /**
     * Tente l'installation par copie LOCALE : l'appareil possède déjà ce contenu
     * exact ailleurs dans le partage (renommage, déplacement, copie). Renvoie
     * `false` si l'agent n'a pas pu — l'appelant retombe alors sur le transfert
     * normal, donc aucun risque de régression.
     */
    private async tryLocalCopy(file: PlanFile, sourceRelPath: string): Promise<boolean> {
        const opId = crypto.randomUUID();
        const queue = new EventQueue();
        this.host.claimOp(opId, this.deviceId, (ev) => queue.push(ev));
        try {
            const sent = this.host.hub.requestSyncApplyLocal(this.deviceId, {
                opId,
                shareId: this.share.id,
                relPath: file.relPath,
                sourceRelPath,
                hash: file.hash,
                size: file.size,
                mtime: file.mtime,
                mode: file.mode
            });
            if (!sent) throw new SessionAbort('error', 'Agent hors ligne');
            for (;;) {
                const ev = await queue.next(OP_TIMEOUT_MS);
                if (ev.type !== 'opResult') continue;
                return ev.ok;
            }
        } finally {
            this.host.releaseOp(opId);
        }
    }

    /**
     * Demande à l'agent où reprendre : le nombre d'octets de clair qu'il détient
     * déjà pour ce hash exact. `0` en cas de doute — se tromper en reprenant
     * trop loin livrerait un fichier faux, alors que repartir de zéro ne coûte
     * que du temps.
     */
    private async askResumeOffset(opId: string, queue: EventQueue, file: PlanFile): Promise<number> {
        const sent = this.host.hub.requestSyncApplyStart(this.deviceId, {
            opId,
            shareId: this.share.id,
            relPath: file.relPath,
            hash: file.hash,
            size: file.size,
            mtime: file.mtime,
            mode: file.mode
        });
        if (!sent) throw new SessionAbort('error', 'Agent hors ligne');
        for (;;) {
            const ev = await queue.next(OP_TIMEOUT_MS);
            if (ev.type !== 'opResult') continue;
            if (!ev.ok) throw new Error(ev.error ?? "Préparation refusée par l'agent");
            // Borné à la taille attendue : un temporaire plus gros que le
            // fichier est forcément périmé. `=== size` reste une reprise valide
            // (le contenu est complet, seule l'installation avait échoué), et
            // c'est justement le cas du fichier verrouillé sous Windows.
            const offset = ev.resumeFrom ?? 0;
            return offset > 0 && offset <= file.size ? offset : 0;
        }
    }

    /** Download serveur → appareil : install atomique côté agent, baseline ensuite. */
    private async downloadToDevice(file: PlanFile): Promise<void> {
        // Un dossier vide se crée sans transfert.
        if (file.kind === 'dir') {
            await this.sendApplyMeta(file);
            await this.writeBaseline(file);
            await this.fileDone(0);
            return;
        }

        // L'appareil a-t-il déjà ce contenu exact ailleurs ? Sa baseline le dit.
        const localSource = this.baselineByHash.get(file.hash);
        if (localSource !== undefined && localSource !== file.relPath) {
            // Ce contenu va-t-il DISPARAÎTRE de son ancien chemin ? Alors c'est
            // un déplacement, et il se renomme : copier puis mettre l'original à
            // la corbeille garderait une copie intégrale pour rien.
            if (this.movedAway.has(localSource)) {
                if (await this.tryMove(file, localSource)) {
                    this.movedAway.delete(localSource);
                    await this.host.db.syncFiles.deleteBaseline(this.share.id, this.deviceId, relPathHash(localSource));
                    await this.writeBaseline(file);
                    await this.fileDone(file.size);
                    return;
                }
            }
            // Sinon le contenu reste aux deux endroits : copie locale, toujours
            // sans transfert réseau.
            if (await this.tryLocalCopy(file, localSource)) {
                await this.writeBaseline(file);
                await this.fileDone(file.size); // Aucun octet sur le fil : compté ici.
                return;
            }
        }

        const opId = crypto.randomUUID();
        const queue = new EventQueue();
        this.host.claimOp(opId, this.deviceId, (ev) => queue.push(ev));
        try {
            let acked = -1;
            const awaitAck = async (until: number): Promise<void> => {
                while (acked < until) {
                    const ev = await queue.next(OP_TIMEOUT_MS);
                    if (ev.type === 'ack') acked = Math.max(acked, ev.seq);
                    else if (ev.type === 'opResult') {
                        throw new Error(ev.error ?? "Installation interrompue par l'agent");
                    }
                }
            };

            // Amorce : l'agent dit combien d'octets il détient déjà pour CE hash,
            // et on ne renvoie que ce qui manque. Son temporaire étant nommé par
            // hash, il ne peut pas s'agir des octets d'une version antérieure.
            const resumeFrom = await this.askResumeOffset(opId, queue, file);
            const frame = (seq: number, data: string, done: boolean) => ({
                opId,
                shareId: this.share.id,
                relPath: file.relPath,
                seq,
                data,
                done,
                hash: file.hash,
                size: file.size,
                mtime: file.mtime,
                mode: file.mode,
                // Répété sur chaque frame : l'agent tronque à cette valeur au
                // lieu de présumer de son propre point de reprise.
                resumeFrom
            });

            let seq = 0;
            this.beginFile(file.relPath, file.size, resumeFrom);
            if (resumeFrom > 0) {
                this.recordNotice(
                    file.relPath,
                    `Téléchargement repris à ${Math.round((resumeFrom / Math.max(1, file.size)) * 100)} % (${resumeFrom} octets déjà en place)`
                );
            }

            for await (const chunk of this.store.read(file.hash, resumeFrom)) {
                this.checkAbort();
                // Fenêtre de crédit : jamais plus de DOWNLOAD_WINDOW frames en vol.
                await awaitAck(seq - DOWNLOAD_WINDOW);
                if (this.downBucket) await this.downBucket.take(chunk.length);
                const sent = this.host.hub.requestSyncApplyChunk(
                    this.deviceId,
                    frame(seq, chunk.toString('base64'), false)
                );
                if (!sent) throw new SessionAbort('error', 'Agent hors ligne');
                await this.advance(chunk.length);
                seq += 1;
            }
            const sent = this.host.hub.requestSyncApplyChunk(this.deviceId, frame(seq, '', true));
            if (!sent) throw new SessionAbort('error', 'Agent hors ligne');

            // L'agent vérifie hash + taille puis installe par rename atomique.
            for (;;) {
                const ev = await queue.next(OP_TIMEOUT_MS);
                if (ev.type !== 'opResult') continue;
                if (!ev.ok) throw new Error(ev.error ?? 'Installation refusée par l’agent');
                break;
            }

            await this.writeBaseline(file);
            await this.fileDone();
        } finally {
            this.endFile();
            this.host.releaseOp(opId);
        }
    }

    /**
     * Un déplacement : le même contenu change de chemin.
     *
     * Ni version, ni corbeille, ni transfert. C'est l'intérêt de l'appariement :
     * traiter les deux moitiés séparément archivait une copie intégrale côté
     * serveur ET en déposait une autre dans la corbeille de chaque pair, pour
     * une opération qui ne détruit rien. Le blob, lui, ne bouge pas d'un octet —
     * il est adressé par son contenu, pas par son chemin.
     *
     * L'appareil source a DÉJÀ déplacé le fichier (c'est ce qui a produit le
     * plan) : il n'y a que l'index à recoller. Les pairs, eux, reçoivent l'ordre
     * de renommer à leur prochaine session.
     */
    private async applyMove(move: PlanMove): Promise<void> {
        const { db } = this.host;
        const fromHash = relPathHash(move.from.relPath);
        const toHash = relPathHash(move.to.relPath);

        await db.syncFiles.upsert({
            shareId: this.share.id,
            relPath: move.to.relPath,
            relPathHash: toHash,
            kind: move.to.kind,
            hash: move.to.hash,
            size: move.to.size,
            mtime: move.to.mtime,
            mode: move.to.mode,
            sourceDeviceId: this.deviceId
        });
        // L'ancien chemin part sans archivage : son contenu vit toujours, sous
        // le nouveau nom. Archiver reviendrait à garder deux fois le même octet.
        await db.syncFiles.markDeleted(this.share.id, fromHash, this.deviceId);
        this.serverChanged = true;

        await db.syncFiles.deleteBaseline(this.share.id, this.deviceId, fromHash);
        await this.writeBaseline(move.to);
        await this.fileDone(0);
    }

    /** Suppression constatée sur l'appareil : archive → index `deleted` → baseline. */
    private async deleteOnServer(file: PlanFile): Promise<void> {
        const { db } = this.host;
        const pathHash = relPathHash(file.relPath);
        const row = await db.syncFiles.getByRelPathHash(this.share.id, pathHash);
        if (row && row.state === 'present') {
            await archiveCurrent(db, this.store, row, 'delete'); // Lève si blob absent.
            await db.syncFiles.markDeleted(this.share.id, pathHash, this.deviceId);
            this.serverChanged = true;
        }
        await db.syncFiles.deleteBaseline(this.share.id, this.deviceId, pathHash);
        await this.fileDone(0);
    }

    /** Suppression à propager : l'appareil ne détruit qu'après preuve d'archive. */
    private async deleteOnDevice(file: PlanFile): Promise<void> {
        const { db } = this.host;
        // Déjà consommée par un renommage plus haut dans le plan : le fichier
        // n'est plus là, et il n'a jamais été détruit.
        if (!this.movedAway.has(file.relPath) && this.baselineByHash.get(file.hash) === file.relPath) {
            await db.syncFiles.deleteBaseline(this.share.id, this.deviceId, relPathHash(file.relPath));
            await this.fileDone(0);
            return;
        }
        // Invariant vérifié côté serveur AVANT l'ordre : une version archivée de ce
        // chemin AVEC ce contenu exact doit exister.
        //
        // Si elle a disparu (purge par budget qui a mordu trop loin, version
        // effacée à la main), refuser en boucle laisserait le fichier fantôme
        // ici et l'erreur reviendrait à CHAQUE cycle, indéfiniment. On reconverge
        // dans l'autre sens : le contenu de l'appareil remonte et ressuscite la
        // ligne d'index. Rien n'est détruit, et l'état redevient cohérent.
        if (!(await db.syncVersions.exists(this.share.id, file.relPath, file.hash))) {
            this.recordNotice(
                file.relPath,
                "Suppression annulée : le contenu n'était plus archivé, le fichier a été remonté depuis cet appareil"
            );
            await this.uploadFromDevice(file, 'overwrite');
            return;
        }

        const opId = crypto.randomUUID();
        const queue = new EventQueue();
        this.host.claimOp(opId, this.deviceId, (ev) => queue.push(ev));
        try {
            const sent = this.host.hub.requestSyncDelete(this.deviceId, {
                opId,
                shareId: this.share.id,
                relPath: file.relPath
            });
            if (!sent) throw new SessionAbort('error', 'Agent hors ligne');
            for (;;) {
                const ev = await queue.next(OP_TIMEOUT_MS);
                if (ev.type !== 'opResult') continue;
                if (!ev.ok) throw new Error(ev.error ?? 'Suppression locale impossible');
                break;
            }
            await db.syncFiles.deleteBaseline(this.share.id, this.deviceId, relPathHash(file.relPath));
            await this.fileDone(0);
        } finally {
            this.host.releaseOp(opId);
        }
    }

    // ─── Progression & issue ───────────────────────────────────────────────────

    private setState(state: SyncSessionState): void {
        this.state = state;
        void this.publishProgress(true);
    }

    /** Entre dans un fichier : la sous-barre part de ce qui est déjà acquis. */
    private beginFile(relPath: string, total: number, already = 0): void {
        this.currentPath = relPath;
        this.currentTotal = total;
        this.currentBytes = already;
    }

    /**
     * Compte des octets réellement passés. Appelé À CHAQUE BLOC, dans les deux
     * sens : sans ça, `bytesDone` n'avançait qu'une fois le fichier terminé et
     * un fichier de plusieurs Go laissait la barre parfaitement figée.
     */
    private async advance(bytes: number): Promise<void> {
        this.bytesDone += bytes;
        this.currentBytes += bytes;
        await this.publishProgress();
    }

    private endFile(): void {
        this.currentBytes = 0;
        this.currentTotal = 0;
    }

    /**
     * Un fichier de plus est terminé. `bytes` ne sert QUE pour les chemins qui
     * ne passent pas d'octets sur le fil (copie locale, dédup, dossier vide) :
     * les transferts réels ont déjà été comptés bloc par bloc par `advance`.
     */
    private async fileDone(bytes = 0): Promise<void> {
        this.filesDone += 1;
        this.bytesDone += bytes;
        this.endFile();
        this.currentPath = null;
        // Throttlé, PAS forcé : sur un partage de milliers de petits fichiers,
        // forcer ici inondait le socket d'une frame par fichier. Les transitions
        // d'état et la fin de session, elles, restent forcées.
        await this.publishProgress();
    }

    private snapshot(error: string | null = null): CloudSyncProgress {
        return {
            shareId: this.share.id,
            deviceId: this.deviceId,
            sessionId: this.sessionId,
            state: this.state,
            filesTotal: this.filesTotal,
            bytesTotal: this.bytesTotal,
            filesDone: this.filesDone,
            bytesDone: this.bytesDone,
            currentPath: this.currentPath,
            currentBytes: this.currentBytes,
            currentTotal: this.currentTotal,
            direction: this.direction,
            error
        };
    }

    private async publishProgress(force = false): Promise<void> {
        const now = Date.now();
        if (force || now - this.lastPublish >= PROGRESS_PUBLISH_MS) {
            this.lastPublish = now;
            this.host.publishProgress(this.snapshot());
        }
        if (now - this.lastPersist >= PROGRESS_PERSIST_MS) {
            await this.persistProgress();
        }
    }

    private async persistProgress(force = false): Promise<void> {
        const now = Date.now();
        if (!force && now - this.lastPersist < PROGRESS_PERSIST_MS) return;
        this.lastPersist = now;
        await this.host.db.syncSessions.updateProgress(this.sessionRowId, {
            state: this.state,
            filesTotal: this.filesTotal,
            bytesTotal: this.bytesTotal,
            filesDone: this.filesDone,
            bytesDone: this.bytesDone
        });
    }

    private async finish(state: 'done' | 'error' | 'cancelled', error: string | null): Promise<void> {
        this.state = state;
        await this.persistProgress(true).catch(() => undefined);
        await this.host.db.syncSessions.finish(this.sessionRowId, state, error);
        this.host.publishProgress(this.snapshot(error));
    }

    private checkAbort(): void {
        if (this.aborted) throw this.aborted;
    }

    /**
     * La pause (partage OU appareil) est relue en base : effective au prochain
     * pas. Mémorisée {@link PAUSE_CHECK_TTL_MS} : deux requêtes SQL par fichier
     * transféré, c'était la moitié du coût d'une session de petits fichiers.
     * Une pause reste donc prise en compte en moins d'une seconde.
     */
    private async checkPaused(): Promise<void> {
        const now = Date.now();
        if (now - this.lastPauseCheck < PAUSE_CHECK_TTL_MS) return;
        this.lastPauseCheck = now;
        const share = await this.host.db.syncShares.findById(this.share.id);
        if (!share) throw new SessionAbort('cancelled', 'Partage supprimé');
        if (share.status === 'paused') throw new SessionAbort('cancelled', 'Synchronisation en pause');
        const device = await this.host.db.syncShares.findDevice(this.share.id, this.deviceId);
        if (!device) throw new SessionAbort('cancelled', 'Appareil détaché');
        if (device.status === 'paused') throw new SessionAbort('cancelled', 'Appareil en pause');
    }
}
