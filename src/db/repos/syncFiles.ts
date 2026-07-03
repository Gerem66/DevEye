import type { SyncDeviceFileRow, SyncFileRow } from 'deveye-types';
import type { Queryable } from '../pool';

type Q = Queryable;

/**
 * Index canonique (`sync_files`) + baselines par appareil (`sync_device_files`).
 *
 * Toute clé de chemin passe par `rel_path_hash` (SHA-256 du chemin relatif
 * NFC-normalisé, calculé par src/cloudSync/pathValidation.ts) — jamais par
 * `rel_path` directement, dont la longueur dépasse ce qu'un index unique
 * MySQL sait couvrir.
 */
export interface SyncFilesRepo {
    listPresentByShare(shareId: number): Promise<SyncFileRow[]>;
    /** Toutes les lignes, y compris `deleted` (3e voie du merge côté serveur). */
    listByShare(shareId: number): Promise<SyncFileRow[]>;
    getByRelPathHash(shareId: number, relPathHash: string): Promise<SyncFileRow | null>;
    /** Fichiers vivants sous un préfixe de dossier (`''` = tout le partage). */
    browseByPrefix(shareId: number, prefix: string): Promise<SyncFileRow[]>;
    upsert(input: {
        shareId: number;
        relPath: string;
        relPathHash: string;
        hash: string;
        size: number;
        mtime: number;
        sourceDeviceId: string | null;
    }): Promise<void>;
    markDeleted(shareId: number, relPathHash: string, sourceDeviceId: string | null): Promise<boolean>;
    /** Un hash est-il encore référencé (index vivant ∪ versions) ? Gate du GC de blobs. */
    isHashReferenced(shareId: number, hash: string): Promise<boolean>;
    statsByShare(shareId: number): Promise<{ fileCount: number; liveBytes: number }>;

    listBaseline(shareId: number, deviceId: string): Promise<SyncDeviceFileRow[]>;
    upsertBaseline(input: {
        shareId: number;
        deviceId: string;
        relPath: string;
        relPathHash: string;
        hash: string;
        size: number;
        mtime: number;
    }): Promise<void>;
    deleteBaseline(shareId: number, deviceId: string, relPathHash: string): Promise<void>;
    /** Purge la baseline d'un chemin pour TOUS les appareils (exclusion ajoutée). */
    deleteBaselineAllDevices(shareId: number, relPathHash: string): Promise<void>;
    clearBaseline(shareId: number, deviceId: string): Promise<void>;
}

export function syncFilesRepo(pool: Q): SyncFilesRepo {
    return {
        async listPresentByShare(shareId) {
            const r = await pool.query<SyncFileRow>(
                "SELECT * FROM sync_files WHERE share_id = ? AND state = 'present'",
                [shareId]
            );
            return r.rows;
        },
        async listByShare(shareId) {
            const r = await pool.query<SyncFileRow>('SELECT * FROM sync_files WHERE share_id = ?', [shareId]);
            return r.rows;
        },
        async getByRelPathHash(shareId, relPathHash) {
            const r = await pool.query<SyncFileRow>(
                'SELECT * FROM sync_files WHERE share_id = ? AND rel_path_hash = ?',
                [shareId, relPathHash]
            );
            return r.rows[0] ?? null;
        },
        async browseByPrefix(shareId, prefix) {
            if (prefix === '') {
                return (
                    await pool.query<SyncFileRow>(
                        "SELECT * FROM sync_files WHERE share_id = ? AND state = 'present' ORDER BY rel_path ASC",
                        [shareId]
                    )
                ).rows;
            }
            // Échappe les métacaractères LIKE du préfixe (chemin littéral).
            const escaped = prefix.replace(/([%_\\])/g, '\\$1');
            const r = await pool.query<SyncFileRow>(
                `SELECT * FROM sync_files
                 WHERE share_id = ? AND state = 'present' AND rel_path LIKE CONCAT(?, '/%')
                 ORDER BY rel_path ASC`,
                [shareId, escaped]
            );
            return r.rows;
        },
        async upsert({ shareId, relPath, relPathHash, hash, size, mtime, sourceDeviceId }) {
            await pool.query(
                `INSERT INTO sync_files (share_id, rel_path, rel_path_hash, hash, size, mtime, source_device_id, state)
                 VALUES (?, ?, ?, ?, ?, ?, ?, 'present')
                 ON DUPLICATE KEY UPDATE
                     hash = VALUES(hash), size = VALUES(size), mtime = VALUES(mtime),
                     source_device_id = VALUES(source_device_id), state = 'present',
                     updated = UNIX_TIMESTAMP()`,
                [shareId, relPath, relPathHash, hash, size, mtime, sourceDeviceId]
            );
        },
        async markDeleted(shareId, relPathHash, sourceDeviceId) {
            const r = await pool.query(
                `UPDATE sync_files
                 SET state = 'deleted', source_device_id = ?, updated = UNIX_TIMESTAMP()
                 WHERE share_id = ? AND rel_path_hash = ? AND state = 'present'`,
                [sourceDeviceId, shareId, relPathHash]
            );
            return r.rowCount > 0;
        },
        async isHashReferenced(shareId, hash) {
            const r = await pool.query<{ n: number }>(
                `SELECT (
                     EXISTS (SELECT 1 FROM sync_files WHERE share_id = ? AND hash = ? AND state = 'present')
                     OR EXISTS (SELECT 1 FROM sync_versions WHERE share_id = ? AND hash = ?)
                 ) AS n`,
                [shareId, hash, shareId, hash]
            );
            return Boolean(r.rows[0]?.n);
        },
        async statsByShare(shareId) {
            const r = await pool.query<{ file_count: number; live_bytes: number | null }>(
                `SELECT COUNT(*) AS file_count, COALESCE(SUM(size), 0) AS live_bytes
                 FROM sync_files WHERE share_id = ? AND state = 'present'`,
                [shareId]
            );
            return {
                fileCount: Number(r.rows[0]?.file_count ?? 0),
                liveBytes: Number(r.rows[0]?.live_bytes ?? 0)
            };
        },

        async listBaseline(shareId, deviceId) {
            const r = await pool.query<SyncDeviceFileRow>(
                'SELECT * FROM sync_device_files WHERE share_id = ? AND device_id = ?',
                [shareId, deviceId]
            );
            return r.rows;
        },
        async upsertBaseline({ shareId, deviceId, relPath, relPathHash, hash, size, mtime }) {
            await pool.query(
                `INSERT INTO sync_device_files (share_id, device_id, rel_path, rel_path_hash, hash, size, mtime)
                 VALUES (?, ?, ?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE
                     hash = VALUES(hash), size = VALUES(size), mtime = VALUES(mtime),
                     synced_at = UNIX_TIMESTAMP()`,
                [shareId, deviceId, relPath, relPathHash, hash, size, mtime]
            );
        },
        async deleteBaseline(shareId, deviceId, relPathHash) {
            await pool.query(
                'DELETE FROM sync_device_files WHERE share_id = ? AND device_id = ? AND rel_path_hash = ?',
                [shareId, deviceId, relPathHash]
            );
        },
        async deleteBaselineAllDevices(shareId, relPathHash) {
            await pool.query('DELETE FROM sync_device_files WHERE share_id = ? AND rel_path_hash = ?', [
                shareId,
                relPathHash
            ]);
        },
        async clearBaseline(shareId, deviceId) {
            await pool.query('DELETE FROM sync_device_files WHERE share_id = ? AND device_id = ?', [shareId, deviceId]);
        }
    };
}
