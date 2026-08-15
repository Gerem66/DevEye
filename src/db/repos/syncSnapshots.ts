import type { SyncSnapshotFileRow, SyncSnapshotKind, SyncSnapshotRow } from 'deveye-types';
import type { Queryable } from '../pool';

type Q = Queryable;

/**
 * Points de restauration du partage ENTIER, là où `sync_versions` est une
 * corbeille par fichier. Un snapshot ne copie AUCUN octet : c'est une photo de
 * `sync_files`, les contenus étant déjà dédupliqués par hash dans le blob store.
 *
 * Conséquence : un snapshot ÉPINGLE ses blobs. `syncFiles.isHashReferenced` (la
 * porte du GC) interroge donc aussi `sync_snapshot_files` — sans quoi la purge
 * des versions détruirait des contenus qu'un snapshot est seul à référencer, et
 * la restauration deviendrait impossible au pire moment.
 */
export interface SyncSnapshotsRepo {
    /**
     * Photographie l'index vivant en une seule requête `INSERT ... SELECT`.
     * Renvoie `null` si le partage est vide (rien à sauvegarder).
     */
    capture(shareId: number, kind: SyncSnapshotKind, label: string | null): Promise<SyncSnapshotRow | null>;
    findById(id: number): Promise<SyncSnapshotRow | null>;
    list(shareId: number, limit: number, offset: number): Promise<SyncSnapshotRow[]>;
    count(shareId: number): Promise<number>;
    files(snapshotId: number): Promise<SyncSnapshotFileRow[]>;
    /** Hashes distincts d'un snapshot (pour le GC après suppression). */
    hashes(snapshotId: number): Promise<string[]>;
    delete(id: number): Promise<boolean>;
    /** Le plus récent d'un partage, toutes origines confondues. */
    latest(shareId: number): Promise<SyncSnapshotRow | null>;
    /** Tous les snapshots d'un partage, du plus récent au plus ancien (rétention). */
    allByShare(shareId: number): Promise<SyncSnapshotRow[]>;
}

export function syncSnapshotsRepo(pool: Q): SyncSnapshotsRepo {
    const byId = async (id: number): Promise<SyncSnapshotRow | null> => {
        const r = await pool.query<SyncSnapshotRow>('SELECT * FROM sync_snapshots WHERE id = ?', [id]);
        return r.rows[0] ?? null;
    };

    return {
        async capture(shareId, kind, label) {
            const created = await pool.query('INSERT INTO sync_snapshots (share_id, kind, label) VALUES (?, ?, ?)', [
                shareId,
                kind,
                label
            ]);
            const snapshotId = created.insertId;
            // Une seule requête : l'index vivant est copié tel quel. Aucune
            // lecture ne remonte en Node, donc la photo est atomique du point de
            // vue de MySQL même sur un partage de plusieurs centaines de milliers
            // de lignes.
            await pool.query(
                `INSERT INTO sync_snapshot_files
                     (snapshot_id, rel_path, rel_path_hash, kind, hash, size, mtime, mode)
                 SELECT ?, rel_path, rel_path_hash, kind, hash, size, mtime, mode
                 FROM sync_files
                 WHERE share_id = ? AND state = 'present'`,
                [snapshotId, shareId]
            );
            const totals = await pool.query<{ n: number; bytes: number | null }>(
                'SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM sync_snapshot_files WHERE snapshot_id = ?',
                [snapshotId]
            );
            const fileCount = Number(totals.rows[0]?.n ?? 0);
            if (fileCount === 0) {
                // Un partage vide ne mérite pas un point de restauration : ça
                // n'aiderait personne et ça encombrerait la liste.
                await pool.query('DELETE FROM sync_snapshots WHERE id = ?', [snapshotId]);
                return null;
            }
            await pool.query('UPDATE sync_snapshots SET file_count = ?, total_bytes = ? WHERE id = ?', [
                fileCount,
                Number(totals.rows[0]?.bytes ?? 0),
                snapshotId
            ]);
            return byId(snapshotId);
        },
        findById: byId,
        async list(shareId, limit, offset) {
            const r = await pool.query<SyncSnapshotRow>(
                `SELECT * FROM sync_snapshots WHERE share_id = ?
                 ORDER BY created DESC, id DESC LIMIT ? OFFSET ?`,
                [shareId, limit, offset]
            );
            return r.rows;
        },
        async count(shareId) {
            const r = await pool.query<{ n: number }>('SELECT COUNT(*) AS n FROM sync_snapshots WHERE share_id = ?', [
                shareId
            ]);
            return Number(r.rows[0]?.n ?? 0);
        },
        async files(snapshotId) {
            const r = await pool.query<SyncSnapshotFileRow>('SELECT * FROM sync_snapshot_files WHERE snapshot_id = ?', [
                snapshotId
            ]);
            return r.rows;
        },
        async hashes(snapshotId) {
            const r = await pool.query<{ hash: string }>(
                'SELECT DISTINCT hash FROM sync_snapshot_files WHERE snapshot_id = ?',
                [snapshotId]
            );
            return r.rows.map((row) => row.hash);
        },
        async delete(id) {
            const r = await pool.query('DELETE FROM sync_snapshots WHERE id = ?', [id]);
            return r.rowCount > 0;
        },
        async latest(shareId) {
            const r = await pool.query<SyncSnapshotRow>(
                'SELECT * FROM sync_snapshots WHERE share_id = ? ORDER BY created DESC, id DESC LIMIT 1',
                [shareId]
            );
            return r.rows[0] ?? null;
        },
        async allByShare(shareId) {
            const r = await pool.query<SyncSnapshotRow>(
                'SELECT * FROM sync_snapshots WHERE share_id = ? ORDER BY created DESC, id DESC',
                [shareId]
            );
            return r.rows;
        }
    };
}
