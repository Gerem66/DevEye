import type { Queryable } from '../pool';

export interface TrustedBrowserRow {
    id: number;
    user_id: number;
    token_hash: string;
    label: string;
    created_at: number;
    last_used_at: number;
    expires_at: number;
}

export interface TrustedBrowsersRepo {
    create(input: { userId: number; tokenHash: string; label: string; now: number; expiresAt: number }): Promise<void>;
    /** Les navigateurs encore reconnus parmi ces condensés de jetons, quel que soit leur compte. */
    findValid(tokenHashes: readonly string[], now: number): Promise<TrustedBrowserRow[]>;
    /** Une connexion vient de passer par lui : sa confiance repart pour un tour. */
    touch(id: number, now: number, expiresAt: number): Promise<void>;
    listByUser(userId: number, now: number): Promise<TrustedBrowserRow[]>;
    remove(userId: number, id: number): Promise<void>;
    removeAllOf(userId: number): Promise<void>;
}

export function trustedBrowsersRepo(pool: Queryable): TrustedBrowsersRepo {
    return {
        async create({ userId, tokenHash, label, now, expiresAt }) {
            await pool.query('DELETE FROM trusted_browsers WHERE user_id = ? AND expires_at <= ?', [userId, now]);
            await pool.query(
                `INSERT INTO trusted_browsers (user_id, token_hash, label, created_at, last_used_at, expires_at)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [userId, tokenHash, label.slice(0, 120), now, now, expiresAt]
            );
        },
        async findValid(tokenHashes, now) {
            if (tokenHashes.length === 0) return [];
            const r = await pool.query<TrustedBrowserRow>(
                'SELECT * FROM trusted_browsers WHERE token_hash IN (?) AND expires_at > ?',
                [[...tokenHashes], now]
            );
            return r.rows;
        },
        async touch(id, now, expiresAt) {
            await pool.query('UPDATE trusted_browsers SET last_used_at = ?, expires_at = ? WHERE id = ?', [
                now,
                expiresAt,
                id
            ]);
        },
        async listByUser(userId, now) {
            const r = await pool.query<TrustedBrowserRow>(
                'SELECT * FROM trusted_browsers WHERE user_id = ? AND expires_at > ? ORDER BY last_used_at DESC',
                [userId, now]
            );
            return r.rows;
        },
        async remove(userId, id) {
            await pool.query('DELETE FROM trusted_browsers WHERE id = ? AND user_id = ?', [id, userId]);
        },
        async removeAllOf(userId) {
            await pool.query('DELETE FROM trusted_browsers WHERE user_id = ?', [userId]);
        }
    };
}
