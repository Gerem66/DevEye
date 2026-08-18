import type { SyncShareRow } from 'deveye-types';
import type { Logger } from 'pino';
import type { Database } from '../db';
import type { AuditLog } from '../Services/AuditLog';
import type { CloudSyncEngine } from './engine';
import { INTEGRITY_BUDGET_BYTES } from './integrity';
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
/**
 * Rétention de l'historique des sessions.
 *
 * La table n'était purgée par RIEN : chaque session y laissait une ligne pour
 * toujours. La création paresseuse (voir `SyncSession.ensureSessionRow`) a réglé
 * la source, ce balayage règle l'accumulation déjà en place.
 */
const SESSION_RETENTION_S = 30 * 24 * 60 * 60;
const HOUR_S = 60 * 60;
const DAY_S = 24 * HOUR_S;
/** En deçà de cet âge, TOUS les points de restauration sont conservés. */
const SNAPSHOT_KEEP_ALL_S = 2 * DAY_S;
/** Puis un seul par jour, jusqu'à cet âge. */
const SNAPSHOT_DAILY_S = 30 * DAY_S;

/**
 * Rétention grand-père / père / fils : tout sur 48 h, puis un par jour sur 30
 * jours, puis un par semaine jusqu'à la limite du partage. Un snapshot ne pesant
 * que des lignes d'index, l'objectif n'est pas d'économiser de la place mais de
 * garder une liste lisible — et de finir par relâcher les blobs épinglés.
 *
 * Les snapshots `manual` et `preRestore` ne sont JAMAIS purgés par l'âge : l'un
 * a été demandé explicitement, l'autre est le bouton « annuler » d'une
 * restauration. Seule la limite absolue du partage finit par les emporter.
 */
export function snapshotsToDrop(
    snapshots: ReadonlyArray<{ id: number; kind: string; created: number }>,
    nowS: number,
    keepDays: number
): number[] {
    const drop: number[] = [];
    const bucketsSeen = new Set<string>();
    // Du plus récent au plus ancien : le premier d'un seau est celui qu'on garde.
    for (const snap of [...snapshots].sort((a, b) => b.created - a.created)) {
        const age = nowS - snap.created;
        if (age > keepDays * DAY_S) {
            drop.push(snap.id);
            continue;
        }
        if (snap.kind !== 'auto') continue; // Manuel / avant-restauration : intouchable.
        if (age <= SNAPSHOT_KEEP_ALL_S) continue;
        const bucket =
            age <= SNAPSHOT_DAILY_S
                ? `d${Math.floor(snap.created / DAY_S)}`
                : `w${Math.floor(snap.created / (7 * DAY_S))}`;
        if (bucketsSeen.has(bucket)) drop.push(snap.id);
        else bucketsSeen.add(bucket);
    }
    return drop;
}

/**
 * Prend un point de restauration automatique si l'intervalle du partage est
 * écoulé ET que l'index a réellement bougé depuis le dernier — sans quoi une
 * machine tranquille accumulerait des photos rigoureusement identiques. Applique
 * ensuite la rétention.
 */
async function maintainSnapshots(
    db: Database,
    engine: CloudSyncEngine,
    audit: AuditLog,
    logger: Logger,
    share: SyncShareRow
): Promise<void> {
    const nowS = Math.floor(Date.now() / 1000);
    if (share.snapshot_enabled) {
        const latest = await db.syncSnapshots.latest(share.id);
        const due = latest === null || nowS - latest.created >= share.snapshot_interval_hours * HOUR_S;
        const changed = latest === null || (await db.syncFiles.lastChangeAt(share.id)) > latest.created;
        if (due && changed) {
            const snapshot = await engine.createSnapshot(share, 'auto');
            if (snapshot !== null) {
                logger.info({ shareId: share.id, snapshotId: snapshot.id }, 'CloudSync: auto snapshot taken');
            }
        }
    }

    const all = await db.syncSnapshots.allByShare(share.id);
    const drop = snapshotsToDrop(all, nowS, share.snapshot_keep_days);
    for (const id of drop) await engine.deleteSnapshot(share, id);
    if (drop.length > 0) {
        audit.record({
            source: 'system',
            category: 'cloudSync',
            action: 'cloudSync.pruneSnapshots',
            uid: share.user_id,
            ip: '',
            description: `CloudSync : ${drop.length} point(s) de restauration purgé(s) sur « ${share.name} »`,
            metadata: { shareId: share.id, pruned: drop.length }
        });
    }
}

export async function pruneCloudSync(
    db: Database,
    engine: CloudSyncEngine,
    audit: AuditLog,
    logger: Logger
): Promise<void> {
    // Le bail d'abord : une instance passive ne doit RIEN solder ni purger.
    if (!(await engine.renewLease())) {
        logger.warn('CloudSync: prune skipped — engine lease held by another instance');
        return;
    }

    const stale = await db.syncSessions.failStale(Math.floor(Date.now() / 1000) - STALE_SESSION_AGE_S);
    if (stale > 0) logger.warn({ stale }, 'CloudSync: stale sessions failed by prune');
    await db.syncEvents.pruneOld(Math.floor(Date.now() / 1000) - EVENT_RETENTION_S);

    // Filet de sécurité : un événement de watcher raté ne laisse jamais deux
    // appareils divergents plus d'une heure (no-op quand tout est synchronisé).
    await engine.scheduleAllActive();

    const sessionCutoff = Math.floor(Date.now() / 1000) - SESSION_RETENTION_S;
    for (const share of await db.syncShares.listAll()) {
        // Borné à un lot par partage et par tour : la purge est un entretien de
        // fond, pas une opération à faire attendre. Un retard éventuel se
        // rattrape au tour d'après, toutes les heures.
        await db.syncSessions.pruneOld(share.id, sessionCutoff, PRUNE_BATCH).catch((err) => {
            logger.error({ err, shareId: share.id }, 'CloudSync: session history prune failed');
        });

        await maintainSnapshots(db, engine, audit, logger, share).catch((err) => {
            logger.error({ err, shareId: share.id }, 'CloudSync: snapshot maintenance failed');
        });

        // Balayage d'intégrité de fond : un petit budget par tour, reprenant où
        // le précédent s'est arrêté. Une corruption au repos se découvre donc
        // toute seule, et non le jour où l'on tente une restauration.
        if (share.integrity_scan_enabled) {
            await engine
                .verifyIntegrity(share, INTEGRITY_BUDGET_BYTES)
                .then((report) => {
                    if (report.corrupted > 0) {
                        audit.record({
                            source: 'system',
                            category: 'cloudSync',
                            action: 'cloudSync.integrityScan',
                            level: 'warning',
                            uid: share.user_id,
                            ip: '',
                            description: `CloudSync : ${report.corrupted} contenu(s) corrompu(s) détecté(s) sur « ${share.name} », ${report.repaired} réparé(s) depuis un appareil`,
                            metadata: { shareId: share.id, ...report }
                        });
                    }
                })
                .catch((err) => {
                    logger.error({ err, shareId: share.id }, 'CloudSync: integrity scan failed');
                });
        }

        if (!share.backup_prune_enabled || share.backup_limit_bytes === null) continue;
        const limit = share.backup_limit_bytes;
        try {
            const pruned = await engine.runExclusive(share.id, async () => {
                const store = await engine.storeFor(share);
                let { totalBytes } = await db.syncVersions.totals(share.id, null);
                let count = 0;
                while (totalBytes > limit) {
                    // `listOldestPrunable` (et non `listOldest`) : les versions qui
                    // portent encore une suppression non propagée sont intouchables,
                    // sinon `deleteOnDevice` ne peut plus prouver l'archivage et
                    // relance l'ordre à chaque cycle sans jamais aboutir.
                    const batch = await db.syncVersions.listOldestPrunable(share.id, PRUNE_BATCH);
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
