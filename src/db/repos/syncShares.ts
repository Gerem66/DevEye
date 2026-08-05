import type {
    SyncConflictPolicy,
    SyncExclusionKind,
    SyncExclusionRow,
    SyncShareDeviceRow,
    SyncShareRow,
    SyncShareStatus
} from 'deveye-types';
import type { Queryable } from '../pool';

type Q = Queryable;

/** Ligne d'appareil attaché, enrichie du nom de l'appareil (pour l'UI). */
export interface SyncShareDeviceNamedRow extends SyncShareDeviceRow {
    device_name: string;
}

/** Assignation vue depuis un appareil : sa ligne + le statut du partage parent. */
export interface SyncDeviceAssignmentRow extends SyncShareDeviceRow {
    share_status: SyncShareStatus;
}

export interface SyncSharesRepo {
    listByWorkspace(workspaceId: number): Promise<SyncShareRow[]>;
    listAll(): Promise<SyncShareRow[]>;
    findById(id: number): Promise<SyncShareRow | null>;
    create(input: { userId: number; workspaceId: number; name: string; storagePath: string }): Promise<SyncShareRow>;
    update(
        id: number,
        input: {
            name: string;
            backupPruneEnabled: boolean;
            backupLimitBytes: number | null;
            conflictPolicy: SyncConflictPolicy;
        }
    ): Promise<SyncShareRow | null>;
    setStatus(id: number, status: SyncShareStatus): Promise<boolean>;
    delete(id: number): Promise<boolean>;
    /** Partages dont le stockage est identique, parent ou enfant de `path` (anti-imbrication). */
    pathsOverlapping(path: string): Promise<SyncShareRow[]>;

    listDevices(shareId: number): Promise<SyncShareDeviceNamedRow[]>;
    findDevice(shareId: number, deviceId: string): Promise<SyncShareDeviceRow | null>;
    /** Les assignations d'un appareil (pour construire son `sync.config`). */
    listByDevice(deviceId: string): Promise<SyncDeviceAssignmentRow[]>;
    attachDevice(input: { shareId: number; deviceId: string; localPath: string }): Promise<void>;
    detachDevice(shareId: number, deviceId: string): Promise<boolean>;
    setDeviceStatus(shareId: number, deviceId: string, status: SyncShareStatus): Promise<boolean>;
    touchDeviceSynced(shareId: number, deviceId: string): Promise<void>;

    listExclusions(shareId: number): Promise<SyncExclusionRow[]>;
    addExclusion(input: { shareId: number; kind: SyncExclusionKind; pattern: string }): Promise<SyncExclusionRow>;
    removeExclusion(id: number, shareId: number): Promise<boolean>;
}

export function syncSharesRepo(pool: Q): SyncSharesRepo {
    return {
        async listByWorkspace(workspaceId) {
            const r = await pool.query<SyncShareRow>(
                'SELECT * FROM sync_shares WHERE workspace_id = ? ORDER BY created ASC, id ASC',
                [workspaceId]
            );
            return r.rows;
        },
        async listAll() {
            const r = await pool.query<SyncShareRow>('SELECT * FROM sync_shares ORDER BY id ASC');
            return r.rows;
        },
        async findById(id) {
            const r = await pool.query<SyncShareRow>('SELECT * FROM sync_shares WHERE id = ?', [id]);
            return r.rows[0] ?? null;
        },
        async create({ userId, workspaceId, name, storagePath }) {
            const res = await pool.query(
                'INSERT INTO sync_shares (user_id, workspace_id, name, storage_path) VALUES (?, ?, ?, ?)',
                [userId, workspaceId, name, storagePath]
            );
            const r = await pool.query<SyncShareRow>('SELECT * FROM sync_shares WHERE id = ?', [res.insertId]);
            return r.rows[0];
        },
        async update(id, { name, backupPruneEnabled, backupLimitBytes, conflictPolicy }) {
            const res = await pool.query(
                `UPDATE sync_shares
                 SET name = ?, backup_prune_enabled = ?, backup_limit_bytes = ?, conflict_policy = ?,
                     updated = UNIX_TIMESTAMP()
                 WHERE id = ?`,
                [name, backupPruneEnabled ? 1 : 0, backupLimitBytes, conflictPolicy, id]
            );
            if (res.rowCount === 0) return null;
            const r = await pool.query<SyncShareRow>('SELECT * FROM sync_shares WHERE id = ?', [id]);
            return r.rows[0] ?? null;
        },
        async setStatus(id, status) {
            const r = await pool.query('UPDATE sync_shares SET status = ?, updated = UNIX_TIMESTAMP() WHERE id = ?', [
                status,
                id
            ]);
            return r.rowCount > 0;
        },
        async delete(id) {
            const r = await pool.query('DELETE FROM sync_shares WHERE id = ?', [id]);
            return r.rowCount > 0;
        },
        async pathsOverlapping(path) {
            const r = await pool.query<SyncShareRow>(
                `SELECT * FROM sync_shares
                 WHERE storage_path = ?
                    OR storage_path LIKE CONCAT(?, '/%')
                    OR ? LIKE CONCAT(storage_path, '/%')`,
                [path, path, path]
            );
            return r.rows;
        },

        async listDevices(shareId) {
            const r = await pool.query<SyncShareDeviceNamedRow>(
                `SELECT sd.*, d.name AS device_name
                 FROM sync_share_devices sd
                 JOIN devices d ON d.id = sd.device_id
                 WHERE sd.share_id = ?
                 ORDER BY sd.created ASC`,
                [shareId]
            );
            return r.rows;
        },
        async findDevice(shareId, deviceId) {
            const r = await pool.query<SyncShareDeviceRow>(
                'SELECT * FROM sync_share_devices WHERE share_id = ? AND device_id = ?',
                [shareId, deviceId]
            );
            return r.rows[0] ?? null;
        },
        async listByDevice(deviceId) {
            const r = await pool.query<SyncDeviceAssignmentRow>(
                `SELECT sd.*, s.status AS share_status
                 FROM sync_share_devices sd
                 JOIN sync_shares s ON s.id = sd.share_id
                 WHERE sd.device_id = ?`,
                [deviceId]
            );
            return r.rows;
        },
        async attachDevice({ shareId, deviceId, localPath }) {
            await pool.query('INSERT INTO sync_share_devices (share_id, device_id, local_path) VALUES (?, ?, ?)', [
                shareId,
                deviceId,
                localPath
            ]);
        },
        async detachDevice(shareId, deviceId) {
            const r = await pool.query('DELETE FROM sync_share_devices WHERE share_id = ? AND device_id = ?', [
                shareId,
                deviceId
            ]);
            return r.rowCount > 0;
        },
        async setDeviceStatus(shareId, deviceId, status) {
            const r = await pool.query(
                'UPDATE sync_share_devices SET status = ? WHERE share_id = ? AND device_id = ?',
                [status, shareId, deviceId]
            );
            return r.rowCount > 0;
        },
        async touchDeviceSynced(shareId, deviceId) {
            await pool.query(
                'UPDATE sync_share_devices SET last_sync_at = UNIX_TIMESTAMP() WHERE share_id = ? AND device_id = ?',
                [shareId, deviceId]
            );
        },

        async listExclusions(shareId) {
            const r = await pool.query<SyncExclusionRow>(
                'SELECT * FROM sync_exclusions WHERE share_id = ? ORDER BY id ASC',
                [shareId]
            );
            return r.rows;
        },
        async addExclusion({ shareId, kind, pattern }) {
            const res = await pool.query('INSERT INTO sync_exclusions (share_id, kind, pattern) VALUES (?, ?, ?)', [
                shareId,
                kind,
                pattern
            ]);
            const r = await pool.query<SyncExclusionRow>('SELECT * FROM sync_exclusions WHERE id = ?', [res.insertId]);
            return r.rows[0];
        },
        async removeExclusion(id, shareId) {
            const r = await pool.query('DELETE FROM sync_exclusions WHERE id = ? AND share_id = ?', [id, shareId]);
            return r.rowCount > 0;
        }
    };
}
