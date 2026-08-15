import type { SyncEventRow } from 'deveye-types';
import type { Queryable } from '../pool';

type Q = Queryable;

/** Ligne d'événement enrichie du nom de l'appareil (pour la popup Logs). */
export interface SyncEventNamedRow extends SyncEventRow {
    device_name: string | null;
}

/** Fenêtre de dédup : un même problème n'écrit qu'une ligne par tranche. */
const DEDUP_WINDOW_S = 24 * 60 * 60;

/** Journal d'un partage : erreurs de synchro datées (fichier + appareil). */
export interface SyncEventsRepo {
    /**
     * Journalise un problème. Un fichier durablement en échec (nom refusé,
     * verrou Windows…) est re-vu à CHAQUE cycle : sans dédup il écrivait une
     * ligne par heure et noyait la popup « Logs ». Une répétition à l'identique
     * dans les 24 h ne fait que rafraîchir la date de la ligne existante.
     */
    insert(input: { shareId: number; deviceId: string | null; relPath: string | null; message: string }): Promise<void>;
    list(shareId: number, limit: number, offset: number): Promise<SyncEventNamedRow[]>;
    count(shareId: number): Promise<number>;
    /** Purge les événements antérieurs à `cutoff` (secondes unix). */
    pruneOld(cutoff: number): Promise<number>;
}

export function syncEventsRepo(pool: Q): SyncEventsRepo {
    return {
        async insert({ shareId, deviceId, relPath, message }) {
            const text = message.slice(0, 500);
            const cutoff = Math.floor(Date.now() / 1000) - DEDUP_WINDOW_S;
            // `rel_path` et `device_id` sont nullables : `<=>` (égalité sûre aux
            // NULL de MySQL) est indispensable ici, `=` ne matcherait jamais.
            // SELECT puis UPDATE par id, et non un UPDATE direct : `affectedRows`
            // compte les lignes MODIFIÉES, donc renverrait 0 pour une répétition
            // dans la même seconde et on ré-insérerait quand même.
            const existing = await pool.query<{ id: number }>(
                `SELECT id FROM sync_events
                 WHERE share_id = ? AND device_id <=> ? AND rel_path <=> ? AND message = ? AND created >= ?
                 ORDER BY created DESC
                 LIMIT 1`,
                [shareId, deviceId, relPath, text, cutoff]
            );
            const previous = existing.rows[0];
            if (previous) {
                await pool.query('UPDATE sync_events SET created = UNIX_TIMESTAMP() WHERE id = ?', [previous.id]);
                return;
            }
            await pool.query('INSERT INTO sync_events (share_id, device_id, rel_path, message) VALUES (?, ?, ?, ?)', [
                shareId,
                deviceId,
                relPath,
                text
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
