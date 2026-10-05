import { createHash, randomUUID } from 'node:crypto';
import type { Queryable } from '../pool';

type Q = Queryable;

interface RefreshTokenRow {
    jti: string;
    user_id: number;
    session_id: string;
    token_hash: string;
    expires_at: number;
    created_at: number;
    revoked_at: number | null;
}

function hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
}

export interface RefreshTokensRepo {
    newSessionId(): string;
    store(input: { jti: string; userId: number; sessionId: string; token: string; expiresAt: number }): Promise<void>;
    isValid(jti: string, token: string): Promise<boolean>;
    /**
     * True when `token` matches a refresh token that was revoked very recently
     * (within `graceSeconds`) and is not yet expired. Used to distinguish a benign
     * concurrent rotation (page reload / multiple tabs) from genuine token reuse.
     */
    wasRecentlyRotated(jti: string, token: string, graceSeconds: number): Promise<boolean>;
    revoke(jti: string): Promise<void>;
    revokeSession(sessionId: string): Promise<void>;
    /** Toutes les sessions d'un compte : suspension et suppression. */
    revokeUser(userId: number): Promise<void>;
    /** Toutes les sessions d'un compte sauf celle qui vient de prouver son secret. */
    revokeUserExcept(userId: number, keepSessionId: string): Promise<void>;
    /** Cette session a-t-elle encore un jeton vivant ? Vérifié à la poignée de main WebSocket. */
    hasLiveSession(sessionId: string): Promise<boolean>;
}

export function refreshTokensRepo(pool: Q): RefreshTokensRepo {
    return {
        newSessionId() {
            return randomUUID();
        },
        async store({ jti, userId, sessionId, token, expiresAt }) {
            await pool.query(
                `INSERT INTO refresh_tokens (jti, user_id, session_id, token_hash, expires_at)
                 VALUES (?, ?, ?, ?, ?)`,
                [jti, userId, sessionId, hashToken(token), expiresAt]
            );
        },
        async isValid(jti, token) {
            const r = await pool.query<RefreshTokenRow>('SELECT * FROM refresh_tokens WHERE jti = ?', [jti]);
            const row = r.rows[0];
            if (!row) return false;
            if (row.revoked_at !== null) return false;
            if (Number(row.expires_at) < Math.floor(Date.now() / 1000)) return false;
            return row.token_hash === hashToken(token);
        },
        async wasRecentlyRotated(jti, token, graceSeconds) {
            const r = await pool.query<RefreshTokenRow>('SELECT * FROM refresh_tokens WHERE jti = ?', [jti]);
            const row = r.rows[0];
            if (!row) return false;
            if (row.token_hash !== hashToken(token)) return false;
            if (row.revoked_at === null) return false;
            const now = Math.floor(Date.now() / 1000);
            if (Number(row.expires_at) < now) return false;
            return now - Number(row.revoked_at) <= graceSeconds;
        },
        async revoke(jti) {
            await pool.query(
                'UPDATE refresh_tokens SET revoked_at = UNIX_TIMESTAMP() WHERE jti = ? AND revoked_at IS NULL',
                [jti]
            );
        },
        async revokeSession(sessionId) {
            await pool.query(
                'UPDATE refresh_tokens SET revoked_at = UNIX_TIMESTAMP() WHERE session_id = ? AND revoked_at IS NULL',
                [sessionId]
            );
        },
        async revokeUser(userId) {
            await pool.query(
                'UPDATE refresh_tokens SET revoked_at = UNIX_TIMESTAMP() WHERE user_id = ? AND revoked_at IS NULL',
                [userId]
            );
        },
        async revokeUserExcept(userId, keepSessionId) {
            await pool.query(
                `UPDATE refresh_tokens SET revoked_at = UNIX_TIMESTAMP()
                 WHERE user_id = ? AND session_id <> ? AND revoked_at IS NULL`,
                [userId, keepSessionId]
            );
        },
        async hasLiveSession(sessionId) {
            const r = await pool.query<{ n: number }>(
                `SELECT COUNT(*) AS n FROM refresh_tokens
                 WHERE session_id = ? AND revoked_at IS NULL AND expires_at > UNIX_TIMESTAMP()`,
                [sessionId]
            );
            return Number(r.rows[0]?.n ?? 0) > 0;
        }
    };
}
