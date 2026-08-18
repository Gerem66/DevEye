import type { SyncSessionRow, SyncSessionState } from 'deveye-types';
import type { Queryable } from '../pool';

type Q = Queryable;

/**
 * Sessions de synchro : progression persistée (~2 s) pour que l'UI retrouve
 * l'état après un reload, et pour marquer en `error` les sessions orphelines
 * (crash serveur mi-transfert) au boot et au prune horaire.
 */
export interface SyncSessionsRepo {
    create(shareId: number, deviceId: string): Promise<SyncSessionRow>;
    updateProgress(
        id: number,
        input: {
            state: SyncSessionState;
            filesTotal: number;
            bytesTotal: number;
            filesDone: number;
            bytesDone: number;
        }
    ): Promise<void>;
    finish(id: number, state: 'done' | 'error' | 'cancelled', error: string | null): Promise<void>;
    /** Marque en erreur toute session non finie démarrée avant `cutoff` (secondes unix). */
    failStale(cutoff: number): Promise<number>;
    /**
     * Supprime les sessions TERMINÉES d'un partage démarrées avant `cutoff`,
     * par lots de `limit`. Rend le nombre de lignes retirées.
     *
     * Par partage, et non en une seule instruction globale : c'est ce qui laisse
     * la suppression suivre `idx_sync_sessions_share (share_id, started)` au lieu
     * de balayer toute la table. `finished IS NOT NULL` protège une session en
     * cours d'une purge accidentelle.
     */
    pruneOld(shareId: number, cutoff: number, limit: number): Promise<number>;
}

export function syncSessionsRepo(pool: Q): SyncSessionsRepo {
    return {
        async create(shareId, deviceId) {
            const res = await pool.query('INSERT INTO sync_sessions (share_id, device_id) VALUES (?, ?)', [
                shareId,
                deviceId
            ]);
            const r = await pool.query<SyncSessionRow>('SELECT * FROM sync_sessions WHERE id = ?', [res.insertId]);
            return r.rows[0];
        },
        async updateProgress(id, { state, filesTotal, bytesTotal, filesDone, bytesDone }) {
            await pool.query(
                `UPDATE sync_sessions
                 SET state = ?, files_total = ?, bytes_total = ?, files_done = ?, bytes_done = ?
                 WHERE id = ?`,
                [state, filesTotal, bytesTotal, filesDone, bytesDone, id]
            );
        },
        async finish(id, state, error) {
            await pool.query(
                'UPDATE sync_sessions SET state = ?, error = ?, finished = UNIX_TIMESTAMP() WHERE id = ?',
                [state, error, id]
            );
        },
        async failStale(cutoff) {
            const r = await pool.query(
                `UPDATE sync_sessions
                 SET state = 'error', error = 'Session interrompue (serveur redémarré ?)', finished = UNIX_TIMESTAMP()
                 WHERE finished IS NULL AND started < ?`,
                [cutoff]
            );
            return r.rowCount;
        },
        async pruneOld(shareId, cutoff, limit) {
            const r = await pool.query(
                `DELETE FROM sync_sessions
                 WHERE share_id = ? AND finished IS NOT NULL AND started < ?
                 LIMIT ?`,
                [shareId, cutoff, limit]
            );
            return r.rowCount;
        }
    };
}
