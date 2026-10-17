import type { Queryable } from '../pool';

export interface LoginHistoryRow {
    id: number;
    user_id: number;
    session_id: string;
    label: string;
    ip: string;
    /** Les codes franchis après le mot de passe, séparés par des virgules (`email,totp`), vide sans code. */
    steps: string;
    trusted: number;
    logged_at: number;
}

/**
 * Les connexions réussies d'un compte. Rien ne les retire une à une : un
 * intrus ne doit pas pouvoir effacer sa trace, seule la purge les allège.
 */
export interface LoginHistoryRepo {
    record(input: {
        userId: number;
        sessionId: string;
        label: string;
        ip: string;
        steps: readonly string[];
        trusted: boolean;
        now: number;
    }): Promise<void>;
    /** Les connexions depuis `since`, la plus récente d'abord. */
    listSince(userId: number, since: number): Promise<LoginHistoryRow[]>;
    countSince(userId: number, since: number): Promise<number>;
    countBefore(userId: number, since: number): Promise<number>;
    purgeBefore(cutoff: number, batch: number): Promise<number>;
}

export function loginHistoryRepo(pool: Queryable): LoginHistoryRepo {
    return {
        async record({ userId, sessionId, label, ip, steps, trusted, now }) {
            await pool.query(
                `INSERT INTO login_history (user_id, session_id, label, ip, steps, trusted, logged_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [userId, sessionId, label.slice(0, 120), ip.slice(0, 45), steps.join(','), trusted ? 1 : 0, now]
            );
        },
        async listSince(userId, since) {
            const r = await pool.query<LoginHistoryRow>(
                'SELECT * FROM login_history WHERE user_id = ? AND logged_at >= ? ORDER BY logged_at DESC, id DESC',
                [userId, since]
            );
            return r.rows;
        },
        async countSince(userId, since) {
            const r = await pool.query<{ n: number }>(
                'SELECT COUNT(*) AS n FROM login_history WHERE user_id = ? AND logged_at >= ?',
                [userId, since]
            );
            return Number(r.rows[0]?.n ?? 0);
        },
        async countBefore(userId, since) {
            const r = await pool.query<{ n: number }>(
                'SELECT COUNT(*) AS n FROM login_history WHERE user_id = ? AND logged_at < ?',
                [userId, since]
            );
            return Number(r.rows[0]?.n ?? 0);
        },
        async purgeBefore(cutoff, batch) {
            const r = await pool.query('DELETE FROM login_history WHERE logged_at < ? LIMIT ?', [cutoff, batch]);
            return r.rowCount;
        }
    };
}
