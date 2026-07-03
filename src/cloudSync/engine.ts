import fs from 'fs/promises';
import path from 'path';
import type {
    CloudSyncChunkPush,
    CloudSyncProgress,
    CloudSyncShareState,
    SyncShareAssignment,
    SyncShareRow,
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
import { relPathHash } from './pathValidation';
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

export class CloudSyncEngine {
    private stores: BlobStoreCache | null = null;
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

    constructor(private readonly deps: EngineDeps) {}

    /** Au boot : dé-wrappe la clé des blobs, solde les sessions orphelines, et
     *  balaye l'index des fichiers devenus exclus pendant que le serveur était
     *  éteint (y compris les déchets d'OS ignorés par défaut). */
    async start(): Promise<void> {
        const { db, crypt, logger } = this.deps;
        const bmk = await ensureBlobKey(db, crypt);
        this.stores = new BlobStoreCache(bmk);
        const stale = await db.syncSessions.failStale(Math.floor(Date.now() / 1000));
        if (stale > 0) logger.warn({ stale }, 'CloudSync: stale sessions marked as failed at boot');
        for (const share of await db.syncShares.listAll()) {
            await this.applyExclusionCleanup(share).catch((err) => {
                logger.error({ err, shareId: share.id }, 'CloudSync: boot exclusion sweep failed');
            });
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
                exclusions: toAssignmentExclusions(await db.syncShares.listExclusions(a.share_id))
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

    private publishShareState(shareId: number): void {
        void this.computeShareState(shareId)
            .then((state) => this.deps.hub.publishSyncState(state))
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
        for (const key of this.running.keys()) {
            if (key.startsWith(`${shareId}:`)) return of('syncing', null);
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
     * Applique les exclusions à l'index : les fichiers désormais exclus sont
     * retirés du « cloud » — archivés d'abord (reason `excluded`, restaurables),
     * marqués supprimés, baselines purgées pour tous les appareils. Les copies
     * locales des appareils, elles, restent intactes (exclu ≠ supprimé chez toi).
     */
    async applyExclusionCleanup(share: SyncShareRow): Promise<number> {
        const { db, audit } = this.deps;
        const removed = await this.runExclusive(share.id, async () => {
            const excluded = compileExclusions(await db.syncShares.listExclusions(share.id));
            const rows = (await db.syncFiles.listPresentByShare(share.id)).filter((r) => excluded(r.rel_path));
            const store = await this.storeFor(share);
            for (const row of rows) {
                await archiveCurrent(db, store, row, 'excluded'); // Lève si blob absent.
                await db.syncFiles.markDeleted(share.id, row.rel_path_hash, null);
                await db.syncFiles.deleteBaselineAllDevices(share.id, row.rel_path_hash);
            }
            return rows.length;
        });
        if (removed > 0) {
            audit.record({
                source: 'system',
                category: 'cloudSync',
                action: 'cloudSync.exclusionCleanup',
                uid: share.user_id,
                ip: '',
                description: `CloudSync : ${removed} fichier(s) exclu(s) retiré(s) du cloud sur « ${share.name} » (archivés en versions)`,
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
                hash: version.hash,
                size: version.size,
                mtime: version.mtime ?? Date.now(),
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
                        const buffered = send({
                            opId,
                            data: pending.subarray(0, WEB_CHUNK_BYTES).toString('base64'),
                            done: false
                        });
                        pending = pending.subarray(WEB_CHUNK_BYTES);
                        while (buffered > WEB_BACKPRESSURE_BYTES) {
                            await new Promise((r) => setTimeout(r, 50));
                            break; // `bufferedAmount` n'est relu qu'au prochain envoi.
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
