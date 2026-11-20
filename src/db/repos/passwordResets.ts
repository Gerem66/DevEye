import type { Queryable } from '../pool';

export interface PasswordResetRow {
    id: number;
    user_id: number;
    token_hash: string;
    expires_at: number;
    created: number;
}

/** Les temps sont en secondes, comme partout en base. */
export interface PasswordResetsRepo {
    /** Une seule demande par compte : la nouvelle remplace l'ancienne, dont le lien meurt. */
    replace(userId: number, tokenHash: string, expiresAt: number): Promise<void>;
    /** La demande encore utilisable. */
    findLive(tokenHash: string, now: number): Promise<PasswordResetRow | null>;
    /** Consomme la demande. `false` si elle a expiré ou si une autre requête l'a fait avant. */
    consume(id: number, now: number): Promise<boolean>;
    removeAllOf(userId: number): Promise<void>;
    purgeExpired(now: number): Promise<number>;
}

export function passwordResetsRepo(pool: Queryable): PasswordResetsRepo {
    return {
        async replace(userId, tokenHash, expiresAt) {
            await pool.query('DELETE FROM password_resets WHERE user_id = ?', [userId]);
            await pool.query('INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES (?, ?, ?)', [
                userId,
                tokenHash,
                expiresAt
            ]);
        },
        async findLive(tokenHash, now) {
            const r = await pool.query<PasswordResetRow>(
                'SELECT * FROM password_resets WHERE token_hash = ? AND expires_at > ?',
                [tokenHash, now]
            );
            return r.rows[0] ?? null;
        },
        async consume(id, now) {
            const r = await pool.query('DELETE FROM password_resets WHERE id = ? AND expires_at > ?', [id, now]);
            return r.rowCount > 0;
        },
        async removeAllOf(userId) {
            await pool.query('DELETE FROM password_resets WHERE user_id = ?', [userId]);
        },
        async purgeExpired(now) {
            const r = await pool.query('DELETE FROM password_resets WHERE expires_at <= ?', [now]);
            return r.rowCount;
        }
    };
}
