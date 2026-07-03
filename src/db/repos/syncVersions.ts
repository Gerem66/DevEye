import type { SyncVersionReason, SyncVersionRow, SyncVersionSort } from 'deveye-types';
import type { Queryable } from '../pool';

type Q = Queryable;

/** Ligne de version enrichie du nom de l'appareil source (pour l'UI). */
export interface SyncVersionNamedRow extends SyncVersionRow {
    source_device_name: string | null;
}

/**
 * Corbeille/versions. L'insertion passe TOUJOURS par
 * src/cloudSync/versions.ts (`archiveCurrent`), qui vérifie d'abord que le
 * blob existe — n'insère jamais ici directement depuis un handler.
 */
export interface SyncVersionsRepo {
    insert(input: {
        shareId: number;
        relPath: string;
        hash: string;
        size: number;
        mtime: number | null;
        sourceDeviceId: string | null;
        reason: SyncVersionReason;
    }): Promise<SyncVersionRow>;
    findById(id: number): Promise<SyncVersionRow | null>;
    /** Une version de ce chemin AVEC ce contenu exact existe-t-elle ? (invariant) */
    exists(shareId: number, relPath: string, hash: string): Promise<boolean>;
    list(
        shareId: number,
        relPath: string | null,
        sort: SyncVersionSort,
        limit: number,
        offset: number
    ): Promise<SyncVersionNamedRow[]>;
    totals(shareId: number, relPath: string | null): Promise<{ total: number; totalBytes: number }>;
    /** Les plus anciennes d'abord — candidates à la purge par budget. */
    listOldest(shareId: number, limit: number): Promise<SyncVersionRow[]>;
    delete(id: number): Promise<boolean>;
    /** Hashes distincts d'une sélection (pour le GC des blobs après suppression). */
    hashesForIds(shareId: number, ids: number[]): Promise<string[]>;
    /** Supprime une sélection (bornée au partage) ; renvoie le nombre effacé. */
    deleteByIds(shareId: number, ids: number[]): Promise<number>;
    /** Tous les hashes distincts du partage (pour le GC après vidage complet). */
    allHashes(shareId: number): Promise<string[]>;
    /** Vide toutes les versions du partage ; renvoie le nombre effacé. */
    deleteAllByShare(shareId: number): Promise<number>;
    statsByShare(shareId: number): Promise<{ versionCount: number; versionBytes: number }>;
}

export function syncVersionsRepo(pool: Q): SyncVersionsRepo {
    return {
        async insert({ shareId, relPath, hash, size, mtime, sourceDeviceId, reason }) {
            const res = await pool.query(
                `INSERT INTO sync_versions (share_id, rel_path, hash, size, mtime, source_device_id, reason)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [shareId, relPath, hash, size, mtime, sourceDeviceId, reason]
            );
            const r = await pool.query<SyncVersionRow>('SELECT * FROM sync_versions WHERE id = ?', [res.insertId]);
            return r.rows[0];
        },
        async findById(id) {
            const r = await pool.query<SyncVersionRow>('SELECT * FROM sync_versions WHERE id = ?', [id]);
            return r.rows[0] ?? null;
        },
        async exists(shareId, relPath, hash) {
            const r = await pool.query<{ n: number }>(
                'SELECT EXISTS (SELECT 1 FROM sync_versions WHERE share_id = ? AND rel_path = ? AND hash = ?) AS n',
                [shareId, relPath, hash]
            );
            return Boolean(r.rows[0]?.n);
        },
        async list(shareId, relPath, sort, limit, offset) {
            // Clauses figées (jamais interpolées depuis l'entrée : `sort` est
            // un enum zod, et la valeur passe par cette table blanche).
            const ORDER: Record<SyncVersionSort, string> = {
                newest: 'v.created DESC, v.id DESC',
                oldest: 'v.created ASC, v.id ASC',
                largest: 'v.size DESC, v.id DESC',
                path: 'v.rel_path ASC, v.id DESC'
            };
            const filter = relPath === null ? '' : ' AND v.rel_path = ?';
            const params: unknown[] = relPath === null ? [shareId, limit, offset] : [shareId, relPath, limit, offset];
            const r = await pool.query<SyncVersionNamedRow>(
                `SELECT v.*, d.name AS source_device_name
                 FROM sync_versions v
                 LEFT JOIN devices d ON d.id = v.source_device_id
                 WHERE v.share_id = ?${filter}
                 ORDER BY ${ORDER[sort]}
                 LIMIT ? OFFSET ?`,
                params
            );
            return r.rows;
        },
        async totals(shareId, relPath) {
            const filter = relPath === null ? '' : ' AND rel_path = ?';
            const params: unknown[] = relPath === null ? [shareId] : [shareId, relPath];
            const r = await pool.query<{ total: number; total_bytes: number | null }>(
                `SELECT COUNT(*) AS total, COALESCE(SUM(size), 0) AS total_bytes
                 FROM sync_versions WHERE share_id = ?${filter}`,
                params
            );
            return {
                total: Number(r.rows[0]?.total ?? 0),
                totalBytes: Number(r.rows[0]?.total_bytes ?? 0)
            };
        },
        async listOldest(shareId, limit) {
            const r = await pool.query<SyncVersionRow>(
                'SELECT * FROM sync_versions WHERE share_id = ? ORDER BY created ASC, id ASC LIMIT ?',
                [shareId, limit]
            );
            return r.rows;
        },
        async delete(id) {
            const r = await pool.query('DELETE FROM sync_versions WHERE id = ?', [id]);
            return r.rowCount > 0;
        },
        async hashesForIds(shareId, ids) {
            if (ids.length === 0) return [];
            const placeholders = ids.map(() => '?').join(', ');
            const r = await pool.query<{ hash: string }>(
                `SELECT DISTINCT hash FROM sync_versions WHERE share_id = ? AND id IN (${placeholders})`,
                [shareId, ...ids]
            );
            return r.rows.map((row) => row.hash);
        },
        async deleteByIds(shareId, ids) {
            if (ids.length === 0) return 0;
            const placeholders = ids.map(() => '?').join(', ');
            const r = await pool.query(`DELETE FROM sync_versions WHERE share_id = ? AND id IN (${placeholders})`, [
                shareId,
                ...ids
            ]);
            return r.rowCount;
        },
        async allHashes(shareId) {
            const r = await pool.query<{ hash: string }>('SELECT DISTINCT hash FROM sync_versions WHERE share_id = ?', [
                shareId
            ]);
            return r.rows.map((row) => row.hash);
        },
        async deleteAllByShare(shareId) {
            const r = await pool.query('DELETE FROM sync_versions WHERE share_id = ?', [shareId]);
            return r.rowCount;
        },
        async statsByShare(shareId) {
            const r = await pool.query<{ version_count: number; version_bytes: number | null }>(
                `SELECT COUNT(*) AS version_count, COALESCE(SUM(size), 0) AS version_bytes
                 FROM sync_versions WHERE share_id = ?`,
                [shareId]
            );
            return {
                versionCount: Number(r.rows[0]?.version_count ?? 0),
                versionBytes: Number(r.rows[0]?.version_bytes ?? 0)
            };
        }
    };
}
