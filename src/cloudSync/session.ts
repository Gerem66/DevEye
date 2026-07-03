import crypto from 'crypto';
import type { CloudSyncProgress, SyncDirection, SyncIndexEntry, SyncSessionState, SyncShareRow } from 'deveye-types';
import type { Logger } from 'pino';
import type { Database } from '../db';
import type { MonitorHub } from '../agent/hub';
import type { ShareBlobStore } from './blobStore';
import { compileExclusions } from './exclusions';
import { planSession, type Plan, type PlanConflict, type PlanFile } from './planner';
import { relPathHash, safeRelPath } from './pathValidation';
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
    | { type: 'opResult'; op: 'apply' | 'delete' | 'push'; ok: boolean; error?: string };

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
/** Chunks `sync.applyChunk` en vol au maximum (crédit d'acks). */
const DOWNLOAD_WINDOW = 4;

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
    private direction: SyncDirection | null = null;
    private lastPublish = 0;
    private lastPersist = 0;
    private aborted: SessionAbort | null = null;
    private readonly failures: string[] = [];
    /** L'index serveur a changé : le moteur re-planifie les AUTRES appareils. */
    private serverChanged = false;

    constructor(
        private readonly host: SessionHost,
        private readonly share: SyncShareRow,
        private readonly deviceId: string,
        private readonly store: ShareBlobStore
    ) {}

    /** Interrompt la session dès la prochaine frontière sûre (fin d'op en cours). */
    abort(outcome: 'cancelled' | 'error', message: string): void {
        this.aborted ??= new SessionAbort(outcome, message);
    }

    /** Vrai si la session a modifié l'index canonique (uploads, suppressions, conflits). */
    get changedServer(): boolean {
        return this.serverChanged;
    }

    /** Consigne un échec par fichier : compteur de session + journal du partage. */
    private recordFailure(relPath: string | null, message: string): void {
        if (relPath !== null) this.failures.push(relPath);
        void this.host.db.syncEvents
            .insert({ shareId: this.share.id, deviceId: this.deviceId, relPath, message })
            .catch(() => undefined);
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

            const entries: SyncIndexEntry[] = [];
            for (;;) {
                this.checkAbort();
                const ev = await queue.next(OP_TIMEOUT_MS);
                if (ev.type !== 'index') continue; // Frame parasite : ignorée.
                if (ev.error) throw new SessionAbort('error', `Scan impossible : ${ev.error}`);
                for (const entry of ev.entries) {
                    // Défense en profondeur : l'agent a déjà filtré, on revalide.
                    const normalized = safeRelPath(entry.relPath);
                    if (normalized === null) {
                        this.recordFailure(entry.relPath, 'Chemin refusé (caractères invalides ou réservés)');
                        continue;
                    }
                    entries.push({ ...entry, relPath: normalized });
                }
                if (ev.done) return entries;
                if (entries.length > 5_000_000) {
                    throw new SessionAbort('error', 'Scan démesuré (plus de 5 M de fichiers)');
                }
            }
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
        // Les chemins exclus (même ajoutés après coup) sont invisibles au merge :
        // ni propagés, ni téléchargés, ni supprimés.
        const server = (await db.syncFiles.listByShare(this.share.id)).filter((r) => !excluded(r.rel_path));
        const device = deviceIndex.filter((e) => !excluded(e.relPath));

        const plan = planSession(device, baseline, server);
        for (const skip of plan.skipped) this.recordFailure(skip.relPath, skip.reason);

        this.filesTotal = plan.filesTotal;
        this.bytesTotal = plan.bytesTotal;
        await this.persistProgress(true);
        return plan;
    }

    // ─── Étape 3 : transferts ──────────────────────────────────────────────────

    private async transfer(plan: Plan): Promise<void> {
        this.setState('transferring');
        const { db } = this.host;

        for (const file of plan.uploads) {
            await this.guardedStep(file.relPath, 'up', () => this.uploadFromDevice(file, 'overwrite'));
        }
        for (const conflict of plan.conflicts) {
            const direction = conflict.winner === 'device' ? 'up' : 'down';
            await this.guardedStep(conflict.server.relPath, direction, () => this.resolveConflict(conflict));
        }
        for (const file of plan.downloads) {
            await this.guardedStep(file.relPath, 'down', () => this.downloadToDevice(file));
        }
        for (const file of plan.deleteOnServer) {
            await this.guardedStep(file.relPath, 'delete', () => this.deleteOnServer(file));
        }
        for (const file of plan.deleteOnDevice) {
            await this.guardedStep(file.relPath, 'delete', () => this.deleteOnDevice(file));
        }

        for (const file of plan.refreshBaseline) {
            await db.syncFiles.upsertBaseline({
                shareId: this.share.id,
                deviceId: this.deviceId,
                relPath: file.relPath,
                relPathHash: relPathHash(file.relPath),
                hash: file.hash,
                size: file.size,
                mtime: file.mtime
            });
        }
        for (const relPath of plan.dropBaseline) {
            await db.syncFiles.deleteBaseline(this.share.id, this.deviceId, relPathHash(relPath));
        }
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
        const { received, mtime } = await this.pullBlobFromDevice(file);
        const { db } = this.host;

        const pathHash = relPathHash(file.relPath);
        const existing = await db.syncFiles.getByRelPathHash(this.share.id, pathHash);
        if (existing && existing.state === 'present' && existing.hash !== received.hash) {
            await archiveCurrent(db, this.store, existing, archiveReason);
        }
        await db.syncFiles.upsert({
            shareId: this.share.id,
            relPath: file.relPath,
            relPathHash: pathHash,
            hash: received.hash,
            size: received.size,
            mtime,
            sourceDeviceId: this.deviceId
        });
        this.serverChanged = true;
        await db.syncFiles.upsertBaseline({
            shareId: this.share.id,
            deviceId: this.deviceId,
            relPath: file.relPath,
            relPathHash: pathHash,
            hash: received.hash,
            size: received.size,
            mtime
        });
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
            hash: file.hash,
            size: file.size,
            mtime: file.mtime,
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
        const writer = await this.store.openWrite(file.hash);
        try {
            const sent = this.host.hub.requestSyncPush(this.deviceId, {
                opId,
                shareId: this.share.id,
                relPath: file.relPath
            });
            if (!sent) throw new SessionAbort('error', 'Agent hors ligne');

            let mtime = file.mtime;
            for (;;) {
                const ev = await queue.next(OP_TIMEOUT_MS);
                if (ev.type !== 'chunk') continue;
                if (ev.error) throw new Error(`Lecture impossible sur l'appareil : ${ev.error}`);
                if (ev.data.length > 0) await writer.write(Buffer.from(ev.data, 'base64'));
                if (ev.done) {
                    if (ev.hash !== undefined && ev.hash !== file.hash) {
                        throw new Error('Fichier modifié pendant le transfert');
                    }
                    if (ev.mtime !== undefined) mtime = ev.mtime;
                    break;
                }
            }
            // `finalize` vérifie le SHA-256 du clair reçu contre l'annonce du scan.
            const received = await writer.finalize();
            return { received, mtime };
        } catch (err) {
            await writer.abort().catch(() => undefined);
            throw err;
        } finally {
            this.host.releaseOp(opId);
        }
    }

    /** Download serveur → appareil : install atomique côté agent, baseline ensuite. */
    private async downloadToDevice(file: PlanFile): Promise<void> {
        const opId = crypto.randomUUID();
        const queue = new EventQueue();
        this.host.claimOp(opId, this.deviceId, (ev) => queue.push(ev));
        try {
            const frame = (seq: number, data: string, done: boolean) => ({
                opId,
                shareId: this.share.id,
                relPath: file.relPath,
                seq,
                data,
                done,
                hash: file.hash,
                size: file.size,
                mtime: file.mtime
            });

            let seq = 0;
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

            for await (const chunk of this.store.read(file.hash)) {
                this.checkAbort();
                // Fenêtre de crédit : jamais plus de DOWNLOAD_WINDOW frames en vol.
                await awaitAck(seq - DOWNLOAD_WINDOW);
                const sent = this.host.hub.requestSyncApplyChunk(
                    this.deviceId,
                    frame(seq, chunk.toString('base64'), false)
                );
                if (!sent) throw new SessionAbort('error', 'Agent hors ligne');
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

            const pathHash = relPathHash(file.relPath);
            await this.host.db.syncFiles.upsertBaseline({
                shareId: this.share.id,
                deviceId: this.deviceId,
                relPath: file.relPath,
                relPathHash: pathHash,
                hash: file.hash,
                size: file.size,
                mtime: file.mtime
            });
            await this.fileDone(file.size);
        } finally {
            this.host.releaseOp(opId);
        }
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
        // Invariant vérifié côté serveur AVANT l'ordre : une version archivée de ce
        // chemin AVEC ce contenu exact doit exister. Sinon rien n'est supprimé.
        if (!(await db.syncVersions.exists(this.share.id, file.relPath, file.hash))) {
            throw new Error('Aucune version archivée de ce contenu — suppression refusée');
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

    private async fileDone(bytes: number): Promise<void> {
        this.filesDone += 1;
        this.bytesDone += bytes;
        await this.publishProgress(true);
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

    /** La pause (partage OU appareil) est relue en base : effective au prochain pas. */
    private async checkPaused(): Promise<void> {
        const share = await this.host.db.syncShares.findById(this.share.id);
        if (!share) throw new SessionAbort('cancelled', 'Partage supprimé');
        if (share.status === 'paused') throw new SessionAbort('cancelled', 'Synchronisation en pause');
        const device = await this.host.db.syncShares.findDevice(this.share.id, this.deviceId);
        if (!device) throw new SessionAbort('cancelled', 'Appareil détaché');
        if (device.status === 'paused') throw new SessionAbort('cancelled', 'Appareil en pause');
    }
}
