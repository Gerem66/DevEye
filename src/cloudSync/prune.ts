import type { Logger } from 'pino';
import type { Database } from '../db';
import type { AuditLog } from '../Services/AuditLog';
import type { CloudSyncEngine } from './engine';
import { gcBlobIfUnreferenced } from './versions';

/**
 * Entretien horaire (branché sur le prune existant de index.ts) :
 *  - purge par budget : pour chaque partage où elle est ACTIVÉE (off par
 *    défaut), supprime les versions les plus anciennes tant que leur volume
 *    dépasse `backup_limit_bytes`, puis GC les blobs orphelins ;
 *  - solde les sessions muettes depuis plus de 6 h.
 * Tout le travail par partage passe sous son mutex (aucune course avec les
 * sessions ou une suppression de version manuelle).
 */

const STALE_SESSION_AGE_S = 6 * 60 * 60;
const PRUNE_BATCH = 200;
/** Rétention du journal d'événements (popup Logs). */
const EVENT_RETENTION_S = 90 * 24 * 60 * 60;

export async function pruneCloudSync(
    db: Database,
    engine: CloudSyncEngine,
    audit: AuditLog,
    logger: Logger
): Promise<void> {
    const stale = await db.syncSessions.failStale(Math.floor(Date.now() / 1000) - STALE_SESSION_AGE_S);
    if (stale > 0) logger.warn({ stale }, 'CloudSync: stale sessions failed by prune');
    await db.syncEvents.pruneOld(Math.floor(Date.now() / 1000) - EVENT_RETENTION_S);

    // Filet de sécurité : un événement de watcher raté ne laisse jamais deux
    // appareils divergents plus d'une heure (no-op quand tout est synchronisé).
    await engine.scheduleAllActive();

    for (const share of await db.syncShares.listAll()) {
        if (!share.backup_prune_enabled || share.backup_limit_bytes === null) continue;
        const limit = share.backup_limit_bytes;
        try {
            const pruned = await engine.runExclusive(share.id, async () => {
                const store = await engine.storeFor(share);
                let { totalBytes } = await db.syncVersions.totals(share.id, null);
                let count = 0;
                while (totalBytes > limit) {
                    const batch = await db.syncVersions.listOldest(share.id, PRUNE_BATCH);
                    if (batch.length === 0) break;
                    for (const version of batch) {
                        if (totalBytes <= limit) break;
                        await db.syncVersions.delete(version.id);
                        await gcBlobIfUnreferenced(db, store, share.id, version.hash);
                        totalBytes -= version.size;
                        count += 1;
                    }
                }
                return count;
            });
            if (pruned > 0) {
                audit.record({
                    source: 'system',
                    category: 'cloudSync',
                    action: 'cloudSync.prune',
                    uid: share.user_id,
                    ip: '',
                    description: `CloudSync : ${pruned} version(s) purgée(s) sur « ${share.name} » (budget dépassé)`,
                    metadata: { shareId: share.id, pruned, limitBytes: limit }
                });
            }
        } catch (err) {
            logger.error({ err, shareId: share.id }, 'CloudSync: prune failed');
        }
    }
}
