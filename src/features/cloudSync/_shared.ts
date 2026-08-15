import type {
    CloudSyncEvent,
    CloudSyncExclusion,
    CloudSyncFile,
    CloudSyncShare,
    CloudSyncVersion,
    SyncExclusionRow,
    SyncFileRow,
    SyncShareRow
} from 'deveye-types';

import type { CloudSyncEngine } from '@/cloudSync/engine';
import type { SyncEventNamedRow } from '@/db/repos/syncEvents';
import type { SyncVersionNamedRow } from '@/db/repos/syncVersions';
import { FeatureError, type FeatureContext } from '../_define';

/** Le moteur est absent uniquement hors WS (tests) — toute commande l'exige. */
export function requireEngine(ctx: FeatureContext): CloudSyncEngine {
    if (!ctx.cloudSync) throw new FeatureError('internal', 'CloudSync indisponible');
    return ctx.cloudSync;
}

/**
 * Le moteur, pour une commande qui MUTE. Refuse quand un autre processus tient
 * le bail : sans cette garde, une instance passive détruirait quand même des
 * versions, restaurerait des snapshots et lancerait des GC en parallèle de
 * l'instance qui travaille — exactement ce que le bail existe pour empêcher.
 */
export function requireActiveEngine(ctx: FeatureContext): CloudSyncEngine {
    const engine = requireEngine(ctx);
    if (!engine.isActive) {
        throw new FeatureError(
            'internal',
            'CloudSync est piloté par un autre processus serveur : cette instance est en lecture seule.'
        );
    }
    return engine;
}

/** Charge un partage de l'espace actif (ou n'importe lequel pour un admin). */
export async function authorizeShare(ctx: FeatureContext, shareId: number): Promise<SyncShareRow> {
    const row = await ctx.db.syncShares.findById(shareId);
    if (!row) throw new FeatureError('not_found', 'Partage introuvable');
    if (row.workspace_id !== ctx.workspaceId && !ctx.isAdmin) {
        throw new FeatureError('forbidden', 'Accès refusé à ce partage');
    }
    return row;
}

export function toClientExclusion(row: SyncExclusionRow): CloudSyncExclusion {
    return { id: row.id, kind: row.kind, pattern: row.pattern };
}

export function toClientFile(row: SyncFileRow): CloudSyncFile {
    return {
        relPath: row.rel_path,
        kind: row.kind,
        hash: row.hash,
        size: row.size,
        mtime: row.mtime,
        mode: row.mode,
        state: row.state,
        updated: row.updated
    };
}

export function toClientEvent(row: SyncEventNamedRow): CloudSyncEvent {
    return {
        id: row.id,
        deviceName: row.device_name,
        relPath: row.rel_path,
        message: row.message,
        created: row.created
    };
}

export function toClientVersion(row: SyncVersionNamedRow): CloudSyncVersion {
    return {
        id: row.id,
        relPath: row.rel_path,
        hash: row.hash,
        size: row.size,
        mtime: row.mtime,
        reason: row.reason,
        sourceDeviceName: row.source_device_name,
        created: row.created
    };
}

/** Assemble la forme client d'un partage (stats, appareils + présence, exclusions). */
export async function toClientShare(ctx: FeatureContext, row: SyncShareRow): Promise<CloudSyncShare> {
    const { db } = ctx;
    const [files, versions, devices, exclusions] = await Promise.all([
        db.syncFiles.statsByShare(row.id),
        db.syncVersions.statsByShare(row.id),
        db.syncShares.listDevices(row.id),
        db.syncShares.listExclusions(row.id)
    ]);
    const online = ctx.monitor?.isOnline(devices.map((d) => d.device_id)) ?? {};
    return {
        id: row.id,
        name: row.name,
        storagePath: row.storage_path,
        status: row.status,
        backupPruneEnabled: Boolean(row.backup_prune_enabled),
        backupLimitBytes: row.backup_limit_bytes,
        snapshotEnabled: Boolean(row.snapshot_enabled),
        snapshotIntervalHours: row.snapshot_interval_hours,
        snapshotKeepDays: row.snapshot_keep_days,
        integrityScanEnabled: Boolean(row.integrity_scan_enabled),
        rateUpBps: row.rate_up_bps,
        rateDownBps: row.rate_down_bps,
        trashKeepDays: row.trash_keep_days,
        conflictPolicy: row.conflict_policy,
        stats: {
            fileCount: files.fileCount,
            liveBytes: files.liveBytes,
            versionCount: versions.versionCount,
            versionBytes: versions.versionBytes
        },
        devices: devices.map((d) => ({
            deviceId: d.device_id,
            deviceName: d.device_name,
            localPath: d.local_path,
            status: d.status,
            online: online[d.device_id] ?? false,
            lastSyncAt: d.last_sync_at
        })),
        exclusions: exclusions.map(toClientExclusion)
    };
}
