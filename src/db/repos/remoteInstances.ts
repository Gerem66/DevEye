import type { RemoteInstance, RemoteInstanceRow } from '@deveye/types';
import type { Queryable } from '../pool';

export const toRemoteInstance = (row: RemoteInstanceRow): RemoteInstance => ({
    id: row.id,
    label: row.label,
    origin: row.origin,
    created: Number(row.created)
});

export interface RemoteInstancesRepo {
    /** Les instances du compte, dans l'ordre du menu. */
    listByUser(userId: number): Promise<RemoteInstanceRow[]>;
    findOwned(userId: number, id: number): Promise<RemoteInstanceRow | null>;
    findByOrigin(userId: number, origin: string): Promise<RemoteInstanceRow | null>;
    countByUser(userId: number): Promise<number>;
    /** Ajoutée en fin de liste. */
    create(input: { userId: number; label: string; origin: string }): Promise<RemoteInstanceRow>;
    rename(userId: number, id: number, label: string): Promise<void>;
    remove(userId: number, id: number): Promise<void>;
    /** Range les instances dans l'ordre donné ; un id étranger au compte est ignoré. */
    reorder(userId: number, ids: readonly number[]): Promise<void>;
}

export function remoteInstancesRepo(pool: Queryable): RemoteInstancesRepo {
    const findOwned = async (userId: number, id: number): Promise<RemoteInstanceRow | null> => {
        const r = await pool.query<RemoteInstanceRow>('SELECT * FROM remote_instances WHERE id = ? AND user_id = ?', [
            id,
            userId
        ]);
        return r.rows[0] ?? null;
    };
    return {
        async listByUser(userId) {
            const r = await pool.query<RemoteInstanceRow>(
                'SELECT * FROM remote_instances WHERE user_id = ? ORDER BY sort_order ASC, id ASC',
                [userId]
            );
            return r.rows;
        },
        findOwned,
        async findByOrigin(userId, origin) {
            const r = await pool.query<RemoteInstanceRow>(
                'SELECT * FROM remote_instances WHERE user_id = ? AND origin = ?',
                [userId, origin]
            );
            return r.rows[0] ?? null;
        },
        async countByUser(userId) {
            const r = await pool.query<{ n: number }>('SELECT COUNT(*) AS n FROM remote_instances WHERE user_id = ?', [
                userId
            ]);
            return Number(r.rows[0]?.n ?? 0);
        },
        async create({ userId, label, origin }) {
            const next = await pool.query<{ next: number }>(
                'SELECT COALESCE(MAX(sort_order) + 1, 0) AS next FROM remote_instances WHERE user_id = ?',
                [userId]
            );
            const res = await pool.query(
                'INSERT INTO remote_instances (user_id, label, origin, sort_order) VALUES (?, ?, ?, ?)',
                [userId, label, origin, Number(next.rows[0]?.next ?? 0)]
            );
            const row = await findOwned(userId, res.insertId);
            if (!row) throw new Error('remote_instances: ligne introuvable après insertion');
            return row;
        },
        async rename(userId, id, label) {
            await pool.query('UPDATE remote_instances SET label = ? WHERE id = ? AND user_id = ?', [label, id, userId]);
        },
        async remove(userId, id) {
            await pool.query('DELETE FROM remote_instances WHERE id = ? AND user_id = ?', [id, userId]);
        },
        async reorder(userId, ids) {
            for (const [position, id] of ids.entries()) {
                await pool.query('UPDATE remote_instances SET sort_order = ? WHERE id = ? AND user_id = ?', [
                    position,
                    id,
                    userId
                ]);
            }
        }
    };
}
