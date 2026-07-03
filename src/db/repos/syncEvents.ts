import type { SyncEventRow } from 'deveye-types';
import type { Queryable } from '../pool';

type Q = Queryable;

/** Ligne d'événement enrichie du nom de l'appareil (pour la popup Logs). */
export interface SyncEventNamedRow extends SyncEventRow {
    device_name: string | null;
}

/** Journal d'un partage : erreurs de synchro datées (fichier + appareil). */
export interface SyncEventsRepo {
    insert(input: { shareId: number; deviceId: string | null; relPath: string | null; message: string }): Promise<void>;
    list(shareId: number, limit: number, offset: number): Promise<SyncEventNamedRow[]>;
    count(shareId: number): Promise<number>;
    /** Purge les événements antérieurs à `cutoff` (secondes unix). */
    pruneOld(cutoff: number): Promise<number>;
}

export function syncEventsRepo(pool: Q): SyncEventsRepo {
    return {
        async insert({ shareId, deviceId, relPath, message }) {
            await pool.query('INSERT INTO sync_events (share_id, device_id, rel_path, message) VALUES (?, ?, ?, ?)', [
                shareId,
                deviceId,
                relPath,
                message.slice(0, 500)
            ]);
        },
        async list(shareId, limit, offset) {
            const r = await pool.query<SyncEventNamedRow>(
                `SELECT e.*, d.name AS device_name
                 FROM sync_events e
                 LEFT JOIN devices d ON d.id = e.device_id
                 WHERE e.share_id = ?
                 ORDER BY e.created DESC, e.id DESC
                 LIMIT ? OFFSET ?`,
                [shareId, limit, offset]
            );
            return r.rows;
        },
        async count(shareId) {
            const r = await pool.query<{ n: number }>('SELECT COUNT(*) AS n FROM sync_events WHERE share_id = ?', [
                shareId
            ]);
            return Number(r.rows[0]?.n ?? 0);
        },
        async pruneOld(cutoff) {
            const r = await pool.query('DELETE FROM sync_events WHERE created < ?', [cutoff]);
            return r.rowCount;
        }
    };
}
