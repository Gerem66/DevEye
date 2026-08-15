import type { SyncDeviceFileRow, SyncEntryKind, SyncFileRow } from 'deveye-types';
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
        kind: SyncEntryKind;
        hash: string;
        size: number;
        mtime: number;
        /** `null` = ne pas toucher au mode déjà en base (agent Windows). */
        mode: number | null;
        sourceDeviceId: string | null;
    }): Promise<void>;
    /** Écrit le seul mode d'une ligne d'index (`chmod` sans transfert). */
    setMode(shareId: number, relPathHash: string, mode: number): Promise<void>;
    markDeleted(shareId: number, relPathHash: string, sourceDeviceId: string | null): Promise<boolean>;
    /** Un hash est-il encore référencé (index vivant ∪ versions) ? Gate du GC de blobs. */
    isHashReferenced(shareId: number, hash: string): Promise<boolean>;
    statsByShare(shareId: number): Promise<{ fileCount: number; liveBytes: number }>;
    /** Dernière mutation de l'index (secondes unix) ; 0 si le partage est vide.
     *  Sert à ne pas photographier deux fois un partage qui n'a pas bougé. */
    lastChangeAt(shareId: number): Promise<number>;
    /**
     * Tous les hashes qu'un blob doit encore avoir sur disque — index vivant,
     * versions et points de restauration réunis, triés pour que le balayage
     * d'intégrité puisse reprendre où il s'est arrêté. Même union que
     * {@link isHashReferenced}, sous forme de liste.
     */
    allReferencedHashes(shareId: number): Promise<string[]>;
    /**
     * Les appareils qui détiennent ce contenu d'après leur baseline, avec le
     * chemin où le demander. C'est ce qui rend un blob corrompu réparable.
     */
    findBaselineHolders(shareId: number, hash: string): Promise<{ device_id: string; rel_path: string }[]>;

    listBaseline(shareId: number, deviceId: string): Promise<SyncDeviceFileRow[]>;
    upsertBaseline(input: {
        shareId: number;
        deviceId: string;
        relPath: string;
        relPathHash: string;
        kind: SyncEntryKind;
        hash: string;
        size: number;
        mtime: number;
        mode: number | null;
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
        async upsert({ shareId, relPath, relPathHash, kind, hash, size, mtime, mode, sourceDeviceId }) {
            await pool.query(
                // `COALESCE(VALUES(mode), mode)` : un agent Windows n'a pas de
                // bits Unix et renvoie NULL. Écrire ce NULL effacerait le mode
                // vu par les agents Unix — un aller-retour par Windows suffirait
                // à faire perdre son bit exécutable à un script. On conserve.
                `INSERT INTO sync_files
                     (share_id, rel_path, rel_path_hash, kind, hash, size, mtime, mode, source_device_id, state)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'present')
                 ON DUPLICATE KEY UPDATE
                     kind = VALUES(kind), hash = VALUES(hash), size = VALUES(size), mtime = VALUES(mtime),
                     mode = COALESCE(VALUES(mode), mode),
                     source_device_id = VALUES(source_device_id), state = 'present',
                     updated = UNIX_TIMESTAMP()`,
                [shareId, relPath, relPathHash, kind, hash, size, mtime, mode, sourceDeviceId]
            );
        },
        async setMode(shareId, relPathHash, mode) {
            await pool.query(
                'UPDATE sync_files SET mode = ?, updated = UNIX_TIMESTAMP() WHERE share_id = ? AND rel_path_hash = ?',
                [mode, shareId, relPathHash]
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
            // Les TROIS référents d'un blob. Oublier `sync_snapshot_files` ici
            // suffirait à ce que la purge des versions détruise un contenu dont
            // un point de restauration est le seul détenteur : la restauration
            // échouerait alors précisément le jour où on en a besoin.
            const r = await pool.query<{ n: number }>(
                `SELECT (
                     EXISTS (SELECT 1 FROM sync_files WHERE share_id = ? AND hash = ? AND state = 'present')
                     OR EXISTS (SELECT 1 FROM sync_versions WHERE share_id = ? AND hash = ?)
                     OR EXISTS (
                         SELECT 1 FROM sync_snapshot_files sf
                         JOIN sync_snapshots s ON s.id = sf.snapshot_id
                         WHERE s.share_id = ? AND sf.hash = ?
                     )
                 ) AS n`,
                [shareId, hash, shareId, hash, shareId, hash]
            );
            return Boolean(r.rows[0]?.n);
        },
        async allReferencedHashes(shareId) {
            const r = await pool.query<{ hash: string }>(
                `SELECT hash FROM sync_files WHERE share_id = ? AND state = 'present' AND kind <> 'dir'
                 UNION
                 SELECT hash FROM sync_versions WHERE share_id = ?
                 UNION
                 SELECT sf.hash FROM sync_snapshot_files sf
                 JOIN sync_snapshots s ON s.id = sf.snapshot_id
                 WHERE s.share_id = ? AND sf.kind <> 'dir'
                 ORDER BY hash ASC`,
                [shareId, shareId, shareId]
            );
            return r.rows.map((row) => row.hash);
        },
        async findBaselineHolders(shareId, hash) {
            const r = await pool.query<{ device_id: string; rel_path: string }>(
                `SELECT device_id, rel_path FROM sync_device_files
                 WHERE share_id = ? AND hash = ? AND kind <> 'dir'`,
                [shareId, hash]
            );
            return r.rows;
        },
        async lastChangeAt(shareId) {
            const r = await pool.query<{ last: number | null }>(
                'SELECT MAX(updated) AS last FROM sync_files WHERE share_id = ?',
                [shareId]
            );
            return Number(r.rows[0]?.last ?? 0);
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
        async upsertBaseline({ shareId, deviceId, relPath, relPathHash, kind, hash, size, mtime, mode }) {
            await pool.query(
                // La baseline décrit ce que l'appareil A RÉELLEMENT : son `mode`
                // NULL (Windows) est une information exacte, pas une lacune —
                // contrairement à l'index, on l'écrit tel quel.
                `INSERT INTO sync_device_files
                     (share_id, device_id, rel_path, rel_path_hash, kind, hash, size, mtime, mode)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE
                     kind = VALUES(kind), hash = VALUES(hash), size = VALUES(size), mtime = VALUES(mtime),
                     mode = VALUES(mode), synced_at = UNIX_TIMESTAMP()`,
                [shareId, deviceId, relPath, relPathHash, kind, hash, size, mtime, mode]
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
