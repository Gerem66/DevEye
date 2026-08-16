import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import type {
    CloudSyncChunkPush,
    CloudSyncProgress,
    CloudSyncShareState,
    CloudSyncSnapshotDiff,
    SyncShareAssignment,
    SyncShareRow,
    SyncSnapshotKind,
    SyncSnapshotRow,
    SyncVersionRow
} from 'deveye-types';
import type { Logger } from 'pino';
import type { MonitorHub, MonitorTransport } from '../agent/hub';
import type { Database } from '../db';
import type { AuditLog } from '../Services/AuditLog';
import type Encryption from '../Services/Encryption';
import { ensureBlobKey } from './blobCrypto';
import { BLOB_STORE_SUBDIRS, BlobStoreCache, type ShareBlobStore } from './blobStore';
import { compileExclusions, toAssignmentExclusions } from './exclusions';
import { verifyShareBlobs, type IntegrityReport } from './integrity';
import { acquireLease, INSTANCE_ID, LEASE_HEARTBEAT_MS, releaseLease, renewLease } from './lease';
import { relPathHash, relPathProblem } from './pathValidation';
import { archiveCurrent, gcBlobIfUnreferenced } from './versions';
import { SyncSession, type AgentSyncEvent, type SessionHost } from './session';

/**
 * Orchestrateur CloudSync (singleton process). Responsabilités :
 *  - cycle de vie de la clé des blobs et des stores par partage ;
 *  - un mutex par partage : sessions, purge, restauration et GC de blobs y
 *    sont TOUS sérialisés — c'est ce qui rend le GC et l'invariant simples ;
 *  - ordonnancement des sessions (une par paire partage×appareil, re-run
 *    coalescé) déclenchées par : connexion d'agent, watcher (`sync.changed`),
 *    « Synchroniser maintenant », changement de config ;
 *  - routage des événements agent vers la session propriétaire (opId) ;
 *  - push de `sync.config` aux agents + événements de progression au web.
 *
 * ⚠️ `runExclusive` est LE point de couture de tout ce qui mute un partage
 * (sessions, hygiène, versions, points de restauration, GC, contrôle
 * d'intégrité). Le jour où une vraie coordination multi-instance sera
 * nécessaire, c'est le SEUL endroit à remplacer — d'où l'interdiction d'écrire
 * une mutation qui le contourne. En attendant, `lease.ts` garantit qu'un seul
 * processus tourne, et un second démarre en mode passif au lieu de corrompre.
 */

interface EngineDeps {
    db: Database;
    hub: MonitorHub;
    crypt: Encryption;
    audit: AuditLog;
    logger: Logger;
}

const pairKey = (shareId: number, deviceId: string): string => `${shareId}:${deviceId}`;

/** Taille des chunks base64 envoyés au navigateur (téléchargements web). */
const WEB_CHUNK_BYTES = 256 * 1024;
/** Au-delà de ce tampon d'envoi web, on laisse le socket respirer. */
const WEB_BACKPRESSURE_BYTES = 8 * 1024 * 1024;
/** Au-delà, on considère le socket mort plutôt que lent (évite une boucle sans fin). */
const WEB_BACKPRESSURE_TIMEOUT_MS = 60_000;

export class CloudSyncEngine {
    private stores: BlobStoreCache | null = null;
    /**
     * Faux quand un AUTRE processus détient le bail : ce moteur sert alors les
     * lectures mais ne planifie rien, ne purge rien, ne détruit rien.
     */
    private active = false;
    private leaseTimer: ReturnType<typeof setInterval> | null = null;
    /** Fin de la chaîne d'exécution sérialisée de chaque partage. */
    private readonly tails = new Map<number, Promise<void>>();
    /** Paires (partage×appareil) en file ou en cours. */
    private readonly queued = new Set<string>();
    private readonly running = new Map<string, SyncSession>();
    /** Une relance a été demandée pendant qu'une session tournait. */
    private readonly rerun = new Set<string>();
    /** opId/sessionId -> routeur d'événements de la session propriétaire. */
    private readonly ops = new Map<string, { deviceId: string; push: (ev: AgentSyncEvent) => void }>();
    /** Dernière progression connue par paire (snapshot des abonnés web). */
    private readonly lastProgress = new Map<string, CloudSyncProgress>();
    /** Dernière erreur de session par partage (état agrégé), effacée au succès. */
    private readonly lastError = new Map<number, string>();
    /** Dernier état PUBLIÉ par partage, pour ne pas repousser à l'identique. */
    private readonly lastState = new Map<number, string>();

    constructor(private readonly deps: EngineDeps) {}

    /** Au boot : dé-wrappe la clé des blobs, solde les sessions orphelines, et
     *  balaye l'index des fichiers devenus exclus pendant que le serveur était
     *  éteint (y compris les déchets d'OS ignorés par défaut). */
    async start(): Promise<void> {
        const { db, crypt, logger, audit } = this.deps;
        const bmk = await ensureBlobKey(db, crypt);
        this.stores = new BlobStoreCache(bmk);

        this.active = await acquireLease(db);
        this.startLeaseHeartbeat();
        if (!this.active) {
            // Surtout PAS de `failStale` ici : il passerait en erreur toutes les
            // sessions vivantes de l'instance qui travaille réellement.
            logger.error(
                { instanceId: INSTANCE_ID },
                'CloudSync: another instance holds the engine lease — starting in read-only mode'
            );
            audit.record({
                source: 'system',
                category: 'cloudSync',
                action: 'cloudSync.passiveInstance',
                level: 'warning',
                uid: 0,
                ip: '',
                description:
                    'CloudSync : un autre processus tient déjà le moteur. Cette instance démarre en lecture seule (aucune synchro, aucune purge) pour ne pas corrompre les partages.',
                metadata: { instanceId: INSTANCE_ID }
            });
            return;
        }

        const stale = await db.syncSessions.failStale(Math.floor(Date.now() / 1000));
        if (stale > 0) logger.warn({ stale }, 'CloudSync: stale sessions marked as failed at boot');
        for (const share of await db.syncShares.listAll()) {
            await this.applyIndexHygiene(share).catch((err) => {
                logger.error({ err, shareId: share.id }, 'CloudSync: boot hygiene sweep failed');
            });
        }
    }

    /** Ce moteur pilote-t-il réellement la synchro ? (bail d'instance détenu) */
    get isActive(): boolean {
        return this.active;
    }

    /**
     * Battement du bail, indépendant de l'entretien horaire.
     *
     * Il lui faut sa propre cadence : le TTL du bail est court exprès (sans
     * quoi un redémarrage, qui change d'identité d'instance, laisserait la
     * synchro morte jusqu'à expiration), donc renouveler seulement toutes les
     * heures reviendrait à le perdre en permanence.
     */
    private startLeaseHeartbeat(): void {
        if (this.leaseTimer !== null) return;
        this.leaseTimer = setInterval(() => void this.renewLease(), LEASE_HEARTBEAT_MS);
        this.leaseTimer.unref();
    }

    /** Arrêt propre : le bail est rendu pour que le prochain démarrage l'obtienne. */
    async stop(): Promise<void> {
        if (this.leaseTimer !== null) {
            clearInterval(this.leaseTimer);
            this.leaseTimer = null;
        }
        if (this.active) await releaseLease(this.deps.db).catch(() => undefined);
        this.active = false;
    }

    /**
     * Renouvelle le bail depuis l'entretien horaire. Le perdre signifie qu'un
     * autre processus a pris la main : on se met immédiatement en retrait.
     */
    async renewLease(): Promise<boolean> {
        if (!this.active) {
            this.active = await acquireLease(this.deps.db);
            if (this.active) {
                this.deps.logger.warn(
                    { instanceId: INSTANCE_ID },
                    'CloudSync: engine lease acquired, leaving read-only mode'
                );
            }
            return this.active;
        }
        this.active = await renewLease(this.deps.db);
        if (!this.active) {
            this.deps.logger.error({ instanceId: INSTANCE_ID }, 'CloudSync: engine lease lost — going read-only');
        }
        return this.active;
    }

    /** Garde des commandes mutantes : refus explicite plutôt que silence. */
    assertActive(): void {
        if (!this.active) {
            throw new Error(
                'CloudSync est piloté par un autre processus serveur : cette instance est en lecture seule.'
            );
        }
    }

    private storeCache(): BlobStoreCache {
        if (!this.stores) throw new Error('CloudSyncEngine non démarré');
        return this.stores;
    }

    /** Le store d'un partage (créé/initialisé paresseusement). */
    storeFor(share: SyncShareRow): Promise<ShareBlobStore> {
        return this.storeCache().for(share.storage_path);
    }

    // ─── Connexions d'agents ───────────────────────────────────────────────────

    /** À la connexion d'un agent : pousser sa config puis rattraper le retard. */
    async onAgentConnect(deviceId: string): Promise<void> {
        await this.pushConfigTo(deviceId);
        const assignments = await this.deps.db.syncShares.listByDevice(deviceId);
        for (const a of assignments) {
            if (a.status === 'active' && a.share_status === 'active') this.schedule(a.share_id, deviceId);
        }
    }

    /** À la déconnexion : interrompre proprement les sessions de cet appareil. */
    onAgentOffline(deviceId: string): void {
        for (const [key, session] of this.running) {
            if (key.endsWith(`:${deviceId}`)) session.abort('error', 'Agent hors ligne');
        }
    }

    /** Construit et pousse `sync.config` (toutes les assignations) à un agent. */
    async pushConfigTo(deviceId: string): Promise<void> {
        const { db, hub } = this.deps;
        if (!hub.isOnline(deviceId)) return;
        const assignments = await db.syncShares.listByDevice(deviceId);
        const shares: SyncShareAssignment[] = [];
        for (const a of assignments) {
            shares.push({
                shareId: a.share_id,
                localPath: a.local_path,
                status: a.status === 'paused' || a.share_status === 'paused' ? 'paused' : 'active',
                exclusions: toAssignmentExclusions(await db.syncShares.listExclusions(a.share_id)),
                // Appliqués PAR l'agent : il est l'émetteur des montées, et le
                // propriétaire de sa corbeille locale.
                rateUpBps: a.rate_up_bps,
                trashKeepDays: a.trash_keep_days
            });
        }
        hub.requestSyncConfig(deviceId, { shares });
    }

    /** Après tout changement de partage/appareil/exclusions : re-push + re-sync. */
    async notifyConfigChanged(shareId: number): Promise<void> {
        const share = await this.deps.db.syncShares.findById(shareId);
        const devices = share === null ? [] : await this.deps.db.syncShares.listDevices(shareId);
        for (const d of devices) {
            await this.pushConfigTo(d.device_id);
            if (share?.status === 'active' && d.status === 'active') this.schedule(shareId, d.device_id);
        }
        this.publishShareState(shareId);
    }

    /** Un appareil détaché doit aussi perdre son assignation (config re-poussée). */
    async notifyDeviceDetached(deviceId: string): Promise<void> {
        await this.pushConfigTo(deviceId);
    }

    // ─── Ordonnancement ────────────────────────────────────────────────────────

    /** Planifie une session pour une paire ; coalesce si déjà en file ou en cours. */
    schedule(shareId: number, deviceId: string): void {
        if (!this.active) return; // Instance passive : la synchro appartient à l'autre.
        const key = pairKey(shareId, deviceId);
        if (this.running.has(key)) {
            this.rerun.add(key);
            return;
        }
        if (this.queued.has(key)) return;
        if (!this.deps.hub.isOnline(deviceId)) return;
        this.queued.add(key);
        void this.runExclusive(shareId, async () => {
            this.queued.delete(key);
            await this.runSession(shareId, deviceId, key);
        });
    }

    /**
     * Filet de sécurité périodique (appelé par le prune horaire) : re-planifie
     * une session pour chaque paire active en ligne. Un partage déjà synchronisé
     * n'y voit qu'un scan à vide — mais un événement de watcher raté ne peut
     * jamais laisser deux appareils divergents plus d'une heure.
     */
    async scheduleAllActive(): Promise<void> {
        for (const share of await this.deps.db.syncShares.listAll()) {
            if (share.status !== 'active') continue;
            for (const d of await this.deps.db.syncShares.listDevices(share.id)) {
                if (d.status === 'active') this.schedule(share.id, d.device_id);
            }
        }
    }

    /** « Synchroniser maintenant » : un appareil précis, ou tous les actifs. */
    async syncNow(shareId: number, deviceId?: string): Promise<number> {
        const devices = await this.deps.db.syncShares.listDevices(shareId);
        let started = 0;
        for (const d of devices) {
            if (deviceId !== undefined && d.device_id !== deviceId) continue;
            if (d.status !== 'active' || !this.deps.hub.isOnline(d.device_id)) continue;
            this.schedule(shareId, d.device_id);
            started += 1;
        }
        return started;
    }

    /**
     * Sérialise un travail sur le partage (sessions, purge, restauration, GC…).
     * Les erreurs du travail précédent ne cassent jamais la chaîne.
     */
    runExclusive<T>(shareId: number, work: () => Promise<T>): Promise<T> {
        const tail = this.tails.get(shareId) ?? Promise.resolve();
        const run = tail.then(work);
        this.tails.set(
            shareId,
            run.then(
                () => undefined,
                () => undefined
            )
        );
        return run;
    }

    private async runSession(shareId: number, deviceId: string, key: string): Promise<void> {
        const { db, hub, logger, audit } = this.deps;
        const share = await db.syncShares.findById(shareId);
        const attached = share === null ? null : await db.syncShares.findDevice(shareId, deviceId);
        if (share === null || attached === null) return;
        if (share.status === 'paused' || attached.status === 'paused') return;
        if (!hub.isOnline(deviceId)) return;

        const host: SessionHost = {
            db,
            hub,
            logger,
            claimOp: (opId, ownerDeviceId, push) => this.ops.set(opId, { deviceId: ownerDeviceId, push }),
            releaseOp: (opId) => this.ops.delete(opId),
            publishProgress: (progress) => {
                this.lastProgress.set(key, progress);
                hub.publishSyncProgress(progress);
                if (progress.state === 'done') {
                    this.lastError.delete(shareId);
                } else if (progress.state === 'error' && progress.error !== null) {
                    this.lastError.set(shareId, progress.error);
                }
                if (['done', 'error', 'cancelled'].includes(progress.state)) {
                    this.publishShareState(shareId);
                }
            }
        };

        const session = new SyncSession(host, share, deviceId, await this.storeFor(share));
        this.running.set(key, session);
        this.publishShareState(shareId);
        try {
            await session.run();
            // Propagation croisée : si cette session a modifié l'index canonique
            // (upload, suppression, conflit), les AUTRES appareils du partage
            // n'ont rien vu localement — on planifie leur rattrapage maintenant.
            if (session.changedServer) {
                const siblings = await db.syncShares.listDevices(shareId);
                for (const d of siblings) {
                    if (d.device_id !== deviceId && d.status === 'active') {
                        this.schedule(shareId, d.device_id);
                    }
                }
            }
        } finally {
            this.running.delete(key);
            const last = this.lastProgress.get(key);
            if (last?.state === 'error') {
                audit.record({
                    source: 'system',
                    category: 'cloudSync',
                    action: 'cloudSync.sessionError',
                    level: 'warning',
                    uid: share.user_id,
                    ip: '',
                    description: `CloudSync : session en erreur sur « ${share.name} » : ${last.error ?? 'inconnue'}`,
                    metadata: { shareId, deviceId }
                });
            }
            this.publishShareState(shareId);
            if (this.rerun.delete(key)) this.schedule(shareId, deviceId);
        }
    }

    // ─── Routage des événements agent ──────────────────────────────────────────

    /** `sync.changed` : le watcher d'un agent a vu bouger un dossier. */
    onSyncChanged(deviceId: string, shareId: number): void {
        this.schedule(shareId, deviceId);
    }

    /** Route un événement corrélé (index/chunk/ack/opResult) vers sa session. */
    routeEvent(deviceId: string, opId: string, ev: AgentSyncEvent): void {
        const owner = this.ops.get(opId);
        if (!owner || owner.deviceId !== deviceId) return; // Op inconnue ou usurpée : ignorée.
        owner.push(ev);
    }

    // ─── État agrégé & snapshots (abonnés web) ─────────────────────────────────

    async liveSnapshot(shareIds: number[]): Promise<{ progress: CloudSyncProgress[]; states: CloudSyncShareState[] }> {
        const progress: CloudSyncProgress[] = [];
        for (const [key, p] of this.lastProgress) {
            const shareId = Number(key.split(':')[0]);
            if (shareIds.includes(shareId) && this.running.has(key)) progress.push(p);
        }
        const states: CloudSyncShareState[] = [];
        for (const shareId of shareIds) states.push(await this.computeShareState(shareId));
        return { progress, states };
    }

    /**
     * Publie l'état agrégé d'un partage — mais seulement s'il a CHANGÉ.
     *
     * Sans cette comparaison, chaque début et fin de session poussait une frame
     * identique aux navigateurs, qui re-rendaient le badge pour rien. Sur un
     * partage tranquille c'était du clignotement permanent pour un état
     * rigoureusement stable.
     */
    private publishShareState(shareId: number): void {
        void this.computeShareState(shareId)
            .then((state) => {
                const serialized = JSON.stringify(state);
                if (this.lastState.get(shareId) === serialized) return;
                this.lastState.set(shareId, serialized);
                this.deps.hub.publishSyncState(state);
            })
            .catch(() => undefined);
    }

    /** L'état qui pilote le héros de l'UI : pause > synchro > erreur > hors ligne > OK.
     *  Embarque la volumétrie fraîche : l'en-tête se met à jour sans re-fetch. */
    async computeShareState(shareId: number): Promise<CloudSyncShareState> {
        const { db, hub } = this.deps;
        const share = await db.syncShares.findById(shareId);
        if (share === null) {
            const empty = { fileCount: 0, liveBytes: 0, versionCount: 0, versionBytes: 0 };
            return { shareId, state: 'error', detail: 'Partage introuvable', stats: empty };
        }
        const [files, versions] = await Promise.all([
            db.syncFiles.statsByShare(shareId),
            db.syncVersions.statsByShare(shareId)
        ]);
        const stats = {
            fileCount: files.fileCount,
            liveBytes: files.liveBytes,
            versionCount: versions.versionCount,
            versionBytes: versions.versionBytes
        };
        const of = (state: CloudSyncShareState['state'], detail: string | null): CloudSyncShareState => ({
            shareId,
            state,
            detail,
            stats
        });

        if (share.status === 'paused') return of('paused', null);
        // `isVisible` et non « une session tourne » : un scan à vide ne doit pas
        // faire clignoter le badge à chaque réveil du watcher.
        for (const [key, session] of this.running) {
            if (key.startsWith(`${shareId}:`) && session.isVisible) return of('syncing', null);
        }
        const error = this.lastError.get(shareId);
        if (error !== undefined) return of('error', error);

        const devices = await db.syncShares.listDevices(shareId);
        const offline = devices.find((d) => d.status === 'active' && !hub.isOnline(d.device_id));
        if (offline) return of('offline', offline.device_name);
        return of('synced', null);
    }

    // ─── Opérations sur les versions & téléchargements web ────────────────────

    /**
     * Hygiène de l'index : retire du « cloud » tout ce qui n'a plus rien à y
     * faire — fichiers devenus exclus, ET chemins non portables (nom refusé par
     * Windows, voir `relPathProblem`) qui feraient échouer un agent Windows à
     * chaque cycle. Dans les deux cas la voie est la même et elle est sûre :
     * archivage d'abord (reason `excluded`, donc restaurable), puis marquage
     * `deleted`, puis purge des baselines de TOUS les appareils.
     *
     * Purger les baselines est ce qui empêche la suppression de se propager :
     * `plan()` filtre ces chemins des deux côtés, ils deviennent simplement
     * invisibles au merge. Les copies locales restent intactes partout.
     */
    async applyIndexHygiene(share: SyncShareRow): Promise<number> {
        const { db, audit, logger } = this.deps;
        const removed = await this.runExclusive(share.id, async () => {
            const excluded = compileExclusions(await db.syncShares.listExclusions(share.id));
            const rows = (await db.syncFiles.listPresentByShare(share.id)).filter(
                (r) => excluded(r.rel_path) || relPathProblem(r.rel_path) !== null
            );
            const store = await this.storeFor(share);
            let count = 0;
            for (const row of rows) {
                const problem = relPathProblem(row.rel_path);
                try {
                    await archiveCurrent(db, store, row, 'excluded'); // Lève si blob absent.
                } catch (err) {
                    // Un blob manquant ne doit pas bloquer tout le balayage : on
                    // laisse la ligne en place et on le signale. Rien n'est perdu.
                    logger.error({ err, shareId: share.id, relPath: row.rel_path }, 'CloudSync: hygiene skip');
                    continue;
                }
                await db.syncFiles.markDeleted(share.id, row.rel_path_hash, null);
                await db.syncFiles.deleteBaselineAllDevices(share.id, row.rel_path_hash);
                if (problem !== null) {
                    await db.syncEvents.insert({
                        shareId: share.id,
                        deviceId: null,
                        relPath: row.rel_path,
                        message: `Retiré du partage : ${problem}. Le fichier reste intact sur l'appareil qui l'a créé.`
                    });
                }
                count += 1;
            }
            return count;
        });
        if (removed > 0) {
            audit.record({
                source: 'system',
                category: 'cloudSync',
                action: 'cloudSync.exclusionCleanup',
                uid: share.user_id,
                ip: '',
                description: `CloudSync : ${removed} fichier(s) retiré(s) du cloud sur « ${share.name} » (exclusions ou noms non portables, archivés en versions)`,
                metadata: { shareId: share.id, removed }
            });
        }
        return removed;
    }

    /** Restaure une version comme contenu courant (l'actuel est archivé d'abord). */
    async restoreVersion(share: SyncShareRow, version: SyncVersionRow): Promise<void> {
        await this.runExclusive(share.id, async () => {
            const { db } = this.deps;
            const store = await this.storeFor(share);
            if (!(await store.has(version.hash))) {
                throw new Error('Le contenu de cette version est introuvable dans le stockage');
            }
            const pathHash = relPathHash(version.rel_path);
            const current = await db.syncFiles.getByRelPathHash(share.id, pathHash);
            if (current && current.state === 'present' && current.hash !== version.hash) {
                await archiveCurrent(db, store, current, 'restore');
            }
            await db.syncFiles.upsert({
                shareId: share.id,
                relPath: version.rel_path,
                relPathHash: pathHash,
                // Une version n'archive jamais un dossier (il n'a pas de contenu).
                kind: 'file',
                hash: version.hash,
                size: version.size,
                mtime: version.mtime ?? Date.now(),
                // `null` : `upsert` conserve alors le mode déjà connu du chemin.
                mode: null,
                sourceDeviceId: version.source_device_id
            });
        });
        // Les appareils récupèrent le contenu restauré à leur prochaine session.
        await this.notifyConfigChanged(share.id);
    }

    /** Supprime une version puis son blob s'il n'est plus référencé. */
    async deleteVersion(share: SyncShareRow, version: SyncVersionRow): Promise<void> {
        await this.runExclusive(share.id, async () => {
            const { db } = this.deps;
            await db.syncVersions.delete(version.id);
            await gcBlobIfUnreferenced(db, await this.storeFor(share), share.id, version.hash);
        });
    }

    /**
     * Supprime une sélection de versions, puis GC des blobs devenus orphelins.
     * L'ordre (supprimer les lignes AVANT le GC) est requis : `gcBlobIfUnreferenced`
     * ne détruit un blob que si plus aucune version/fichier ne le référence.
     */
    async deleteVersions(share: SyncShareRow, versionIds: number[]): Promise<number> {
        return this.runExclusive(share.id, async () => {
            const { db } = this.deps;
            const hashes = await db.syncVersions.hashesForIds(share.id, versionIds);
            const deleted = await db.syncVersions.deleteByIds(share.id, versionIds);
            const store = await this.storeFor(share);
            for (const hash of hashes) await gcBlobIfUnreferenced(db, store, share.id, hash);
            return deleted;
        });
    }

    /** Vide toute la corbeille du partage, puis GC des blobs orphelins. */
    async clearVersions(share: SyncShareRow): Promise<number> {
        return this.runExclusive(share.id, async () => {
            const { db } = this.deps;
            const hashes = await db.syncVersions.allHashes(share.id);
            const deleted = await db.syncVersions.deleteAllByShare(share.id);
            const store = await this.storeFor(share);
            for (const hash of hashes) await gcBlobIfUnreferenced(db, store, share.id, hash);
            return deleted;
        });
    }

    // ─── Intégrité du stockage ─────────────────────────────────────────────────

    /**
     * Vérifie les blobs d'un partage (scellés + SHA-256). `budgetBytes` borne le
     * travail pour le balayage de fond ; `null` fait un passage complet.
     *
     * Sous le mutex du partage : un GC ou une restauration qui tournerait en
     * même temps pourrait faire disparaître un blob sous les pieds du contrôle
     * et le faire passer pour corrompu.
     */
    async verifyIntegrity(share: SyncShareRow, budgetBytes: number | null): Promise<IntegrityReport> {
        return this.runExclusive(share.id, async () =>
            verifyShareBlobs(this.deps.db, await this.storeFor(share), share.id, this.deps.logger, {
                budgetBytes,
                repairer: { repair: (shareId, hash) => this.refetchBlob(shareId, hash) }
            })
        );
    }

    /**
     * Reconstruit un blob corrompu en le redemandant à un appareil EN LIGNE qui
     * le détient encore, d'après sa baseline. C'est ce qui rend une corruption
     * disque réparable au lieu d'être une perte sèche.
     *
     * Déjà sous le mutex du partage (appelé depuis `verifyIntegrity`), donc
     * aucune session ne peut réécrire ce blob en même temps.
     */
    private async refetchBlob(shareId: number, hash: string): Promise<boolean> {
        const { db, hub, logger } = this.deps;
        const share = await db.syncShares.findById(shareId);
        if (share === null) return false;
        const store = await this.storeFor(share);

        for (const holder of await db.syncFiles.findBaselineHolders(shareId, hash)) {
            if (!hub.isOnline(holder.device_id)) continue;
            try {
                const received = await this.pullBlobDirect(store, holder.device_id, shareId, holder.rel_path, hash);
                if (received) {
                    logger.warn({ shareId, hash, deviceId: holder.device_id }, 'CloudSync: blob repaired from device');
                    return true;
                }
            } catch (err) {
                logger.warn({ err, shareId, hash }, 'CloudSync: blob repair attempt failed');
            }
        }
        return false;
    }

    /** Rapatrie un contenu depuis un appareil, hors session, pour réparation. */
    private async pullBlobDirect(
        store: ShareBlobStore,
        deviceId: string,
        shareId: number,
        relPath: string,
        hash: string
    ): Promise<boolean> {
        const opId = crypto.randomUUID();
        const chunks: AgentSyncEvent[] = [];
        let notify: (() => void) | null = null;
        this.ops.set(opId, {
            deviceId,
            push: (ev) => {
                chunks.push(ev);
                notify?.();
            }
        });
        // Le partiel du hash courant est illisible (c'est le blob à réparer) :
        // on repart forcément de zéro, d'où `openWrite(null)` puis vérification
        // explicite du hash obtenu.
        const writer = await store.openWrite(null);
        try {
            if (!this.deps.hub.requestSyncPush(deviceId, { opId, shareId, relPath, startOffset: 0 })) return false;
            for (;;) {
                const ev = chunks.shift();
                if (!ev) {
                    await new Promise<void>((resolve) => {
                        notify = resolve;
                        setTimeout(resolve, 60_000);
                    });
                    notify = null;
                    if (chunks.length === 0) throw new Error('Agent silencieux pendant la réparation');
                    continue;
                }
                if (ev.type !== 'chunk') continue;
                if (ev.error) throw new Error(ev.error);
                if (ev.data.length > 0) await writer.write(Buffer.from(ev.data, 'base64'));
                if (ev.done) break;
            }
            const received = await writer.finalize();
            // `openWrite(null)` n'a rien à vérifier : c'est ici qu'on refuse un
            // contenu qui ne serait pas celui qu'on cherchait à réparer. Le
            // blob obtenu part par le GC et JAMAIS par `deleteBlob` : ce même
            // contenu peut très bien être référencé ailleurs dans le partage,
            // auquel cas le détruire serait une perte sèche.
            if (received.hash !== hash) {
                await gcBlobIfUnreferenced(this.deps.db, store, shareId, received.hash);
                return false;
            }
            return true;
        } catch (err) {
            await writer.abort().catch(() => undefined);
            throw err;
        } finally {
            this.ops.delete(opId);
        }
    }

    // ─── Points de restauration (snapshots) ────────────────────────────────────

    /**
     * Prend une photo de l'index vivant. Aucun octet n'est copié : les blobs
     * sont déjà partagés par hash, le snapshot ne fait que les ÉPINGLER contre
     * le GC (voir `syncFiles.isHashReferenced`).
     */
    async createSnapshot(
        share: SyncShareRow,
        kind: SyncSnapshotKind,
        label: string | null = null
    ): Promise<SyncSnapshotRow | null> {
        return this.runExclusive(share.id, () => this.deps.db.syncSnapshots.capture(share.id, kind, label));
    }

    /**
     * Ce que changerait une restauration, sans rien appliquer. `missingBlobs`
     * est le chiffre qui compte : tant qu'il n'est pas nul, la restauration sera
     * refusée en bloc.
     */
    async diffSnapshot(share: SyncShareRow, snapshotId: number): Promise<CloudSyncSnapshotDiff> {
        const { db } = this.deps;
        const store = await this.storeFor(share);
        const snapshot = await db.syncSnapshots.files(snapshotId);
        const live = new Map(
            (await db.syncFiles.listPresentByShare(share.id)).map((r) => [r.rel_path_hash, r] as const)
        );

        const wanted = new Map(snapshot.map((e) => [e.rel_path_hash, e] as const));

        let restored = 0;
        let unchanged = 0;
        let missingBlobs = 0;
        // Un même contenu revient souvent plusieurs fois : chaque blob n'est
        // testé qu'une seule fois sur le disque.
        const present = new Map<string, boolean>();
        const blobMissing = async (hash: string): Promise<boolean> => {
            let ok = present.get(hash);
            if (ok === undefined) {
                ok = await store.has(hash);
                present.set(hash, ok);
            }
            return !ok;
        };

        for (const entry of wanted.values()) {
            const current = live.get(entry.rel_path_hash);
            if (current && current.hash === entry.hash && current.kind === entry.kind) {
                unchanged += 1;
                continue;
            }
            restored += 1;
            if (entry.kind === 'dir') continue; // Un dossier n'a pas de blob.
            if (await blobMissing(entry.hash)) missingBlobs += 1;
        }

        // Les contenus VIVANTS que la restauration va ARCHIVER comptent aussi :
        // `archiveCurrent` refuse un blob absent, et lèverait alors en plein
        // milieu de la boucle — laissant le partage à moitié restauré, ce que la
        // promesse « vérification AVANT toute mutation » interdit.
        let removed = 0;
        for (const [pathHash, row] of live) {
            const target = wanted.get(pathHash);
            if (target === undefined) removed += 1;
            if (row.kind === 'dir') continue;
            const willArchive = target === undefined || target.hash !== row.hash;
            if (willArchive && (await blobMissing(row.hash))) missingBlobs += 1;
        }
        return { restored, removed, unchanged, missingBlobs };
    }

    /**
     * Remet le partage dans l'état du snapshot. RÉVERSIBLE : un snapshot
     * `preRestore` de l'état courant est pris d'abord, donc « annuler » revient
     * à restaurer celui-là.
     *
     * Aucune voie nouvelle vers le disque : tout passe par `archiveCurrent`,
     * `upsert` et `markDeleted`, exactement comme une session. L'invariant
     * anti-perte tient donc par construction, et les appareils convergent
     * ensuite par le chemin normal (téléchargements + suppressions propagées,
     * dont l'exigence de version archivée est satisfaite par l'étape de retrait).
     */
    async restoreSnapshot(
        share: SyncShareRow,
        snapshot: SyncSnapshotRow
    ): Promise<{ restored: number; removed: number; undoSnapshotId: number }> {
        const { db, audit } = this.deps;

        // Vérification AVANT toute mutation : un seul contenu manquant et on
        // n'entame rien. Une restauration à moitié faite serait pire que pas de
        // restauration du tout.
        const diff = await this.diffSnapshot(share, snapshot.id);
        if (diff.missingBlobs > 0) {
            throw new Error(
                `Restauration impossible : ${diff.missingBlobs} contenu(s) de ce point de restauration ont disparu du stockage`
            );
        }

        const outcome = await this.runExclusive(share.id, async () => {
            const stamp = new Date(snapshot.created * 1000).toLocaleString('fr-FR');
            const undo = await db.syncSnapshots.capture(share.id, 'preRestore', `Avant restauration du ${stamp}`);
            const store = await this.storeFor(share);
            const entries = await db.syncSnapshots.files(snapshot.id);
            const live = new Map(
                (await db.syncFiles.listPresentByShare(share.id)).map((r) => [r.rel_path_hash, r] as const)
            );

            let restored = 0;
            const seen = new Set<string>();
            for (const entry of entries) {
                seen.add(entry.rel_path_hash);
                const current = live.get(entry.rel_path_hash);
                if (current && current.hash === entry.hash && current.kind === entry.kind) continue;
                if (current && current.kind !== 'dir') {
                    await archiveCurrent(db, store, current, 'restore'); // Lève si blob absent.
                }
                await db.syncFiles.upsert({
                    shareId: share.id,
                    relPath: entry.rel_path,
                    relPathHash: entry.rel_path_hash,
                    kind: entry.kind,
                    hash: entry.hash,
                    size: entry.size,
                    mtime: entry.mtime,
                    mode: entry.mode,
                    sourceDeviceId: null
                });
                restored += 1;
            }

            // Ce qui est apparu APRÈS le snapshot doit disparaître, sinon le
            // dossier ne serait pas « comme il était ». Archivé d'abord, donc
            // récupérable dans les versions comme n'importe quelle suppression.
            let removed = 0;
            for (const [pathHash, row] of live) {
                if (seen.has(pathHash)) continue;
                if (row.kind !== 'dir') await archiveCurrent(db, store, row, 'restore');
                await db.syncFiles.markDeleted(share.id, pathHash, null);
                removed += 1;
            }
            return { restored, removed, undoSnapshotId: undo?.id ?? snapshot.id };
        });

        audit.record({
            source: 'system',
            category: 'cloudSync',
            action: 'cloudSync.restoreSnapshot',
            level: 'warning',
            uid: share.user_id,
            ip: '',
            description: `CloudSync : partage « ${share.name} » restauré (${outcome.restored} rétabli(s), ${outcome.removed} retiré(s))`,
            metadata: { shareId: share.id, snapshotId: snapshot.id, ...outcome }
        });
        // Les appareils rattrapent par le chemin normal.
        await this.notifyConfigChanged(share.id);
        return outcome;
    }

    /** Supprime un point de restauration, puis GC des blobs devenus orphelins. */
    async deleteSnapshot(share: SyncShareRow, snapshotId: number): Promise<void> {
        await this.runExclusive(share.id, async () => {
            const { db } = this.deps;
            const hashes = await db.syncSnapshots.hashes(snapshotId);
            await db.syncSnapshots.delete(snapshotId);
            const store = await this.storeFor(share);
            for (const hash of hashes) await gcBlobIfUnreferenced(db, store, share.id, hash);
        });
    }

    /** Suppression d'un partage : sessions stoppées, store oublié, données au choix. */
    async deleteShare(share: SyncShareRow, deleteData: boolean): Promise<void> {
        // Capturés AVANT la suppression : le CASCADE efface les lignes d'attache.
        const deviceRows = await this.deps.db.syncShares.listDevices(share.id);
        for (const [key, session] of this.running) {
            if (key.startsWith(`${share.id}:`)) session.abort('cancelled', 'Partage supprimé');
        }
        await this.runExclusive(share.id, async () => {
            await this.deps.db.syncShares.delete(share.id);
            this.storeCache().drop(share.storage_path);
            this.lastState.delete(share.id);
            if (deleteData) {
                // On n'efface QUE ce que le store possède (`blobs/`, `tmp/`) —
                // jamais un rm -rf du dossier de stockage entier, qui pourrait
                // contenir des fichiers étrangers. Le dossier lui-même n'est
                // retiré que s'il finit vide (rmdir non récursif, best-effort).
                for (const sub of BLOB_STORE_SUBDIRS) {
                    await fs.rm(path.join(share.storage_path, sub), { recursive: true, force: true });
                }
                await fs.rmdir(share.storage_path).catch(() => undefined);
            }
        });
        for (const d of deviceRows) await this.pushConfigTo(d.device_id);
    }

    /**
     * Téléchargement web : streame un blob vers UN socket en frames
     * `cloudSync.chunk` (base64), avec backpressure sur le tampon d'envoi.
     * Fire-and-forget côté handler ; toute erreur part en frame terminale.
     */
    streamBlobToSocket(transport: MonitorTransport, share: SyncShareRow, hash: string, opId: string): void {
        void (async () => {
            const send = (payload: CloudSyncChunkPush) => transport.sendSyncChunk(payload);
            try {
                const store = await this.storeFor(share);
                let pending: Buffer = Buffer.alloc(0);
                for await (const chunk of store.read(hash)) {
                    pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
                    while (pending.length >= WEB_CHUNK_BYTES) {
                        let buffered = send({
                            opId,
                            data: pending.subarray(0, WEB_CHUNK_BYTES).toString('base64'),
                            done: false
                        });
                        pending = pending.subarray(WEB_CHUNK_BYTES);
                        // Vraie attente : le tampon est RE-LU à chaque tour. Sur un
                        // navigateur lent, un gros fichier remplissait sinon la
                        // mémoire du serveur aussi vite que le disque le lisait.
                        // Bornée : un socket mort ne vide jamais son tampon, et
                        // on ne veut pas d'une boucle éternelle pour autant.
                        for (let waited = 0; buffered > WEB_BACKPRESSURE_BYTES; waited += 50) {
                            if (waited >= WEB_BACKPRESSURE_TIMEOUT_MS) {
                                throw new Error('Client trop lent (tampon d’envoi saturé)');
                            }
                            await new Promise((r) => setTimeout(r, 50));
                            buffered = transport.syncChunkBuffered();
                        }
                    }
                }
                if (pending.length > 0) send({ opId, data: pending.toString('base64'), done: false });
                send({ opId, data: '', done: true });
            } catch (err) {
                this.deps.logger.warn({ err, opId }, 'CloudSync: web download failed');
                send({ opId, data: '', done: true, error: 'Téléchargement interrompu' });
            }
        })();
    }
}
