import type { Queryable } from '../pool';

type Q = Queryable;

export interface PendingSignupRow {
    id: number;
    email: string;
    username: string;
    token_hash: string;
    watch_hash: string;
    plan: string | null;
    terms_accepted_at: number | null;
    opened_at: number | null;
    completed_at: number | null;
    expires_at: number;
    created: number;
}

export interface PendingSignupInput {
    email: string;
    username: string;
    tokenHash: string;
    watchHash: string;
    plan: string | null;
    termsAcceptedAt: number | null;
    expiresAt: number;
}

/** Une demande aboutie reste lisible ce délai, le temps que l'onglet d'origine l'apprenne. */
const DONE_LINGER_SECONDS = 600;

/** Les temps sont en secondes, comme partout en base. */
export interface PendingSignupsRepo {
    /** Une seule demande par adresse : la nouvelle remplace l'ancienne, dont le lien meurt. */
    replace(input: PendingSignupInput): Promise<void>;
    /** La demande encore utilisable : ni expirée, ni aboutie. */
    findLiveByTokenHash(tokenHash: string, now: number): Promise<PendingSignupRow | null>;
    findByWatchHash(watchHash: string): Promise<PendingSignupRow | null>;
    markOpened(id: number, now: number): Promise<void>;
    /** Consomme la demande. `false` si une autre requête l'a fait avant. */
    markCompleted(id: number, now: number): Promise<boolean>;
    /** Le pseudo est-il retenu par la demande vivante d'une AUTRE adresse ? */
    usernameHeld(username: string, exceptEmail: string, now: number): Promise<boolean>;
    purgeExpired(now: number): Promise<number>;
}

export function pendingSignupsRepo(pool: Q): PendingSignupsRepo {
    return {
        async replace({ email, username, tokenHash, watchHash, plan, termsAcceptedAt, expiresAt }) {
            await pool.query('DELETE FROM pending_signups WHERE email = ?', [email]);
            await pool.query(
                `INSERT INTO pending_signups (email, username, token_hash, watch_hash, plan, terms_accepted_at, expires_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [email, username, tokenHash, watchHash, plan, termsAcceptedAt, expiresAt]
            );
        },
        async findLiveByTokenHash(tokenHash, now) {
            const r = await pool.query<PendingSignupRow>(
                'SELECT * FROM pending_signups WHERE token_hash = ? AND expires_at > ? AND completed_at IS NULL',
                [tokenHash, now]
            );
            return r.rows[0] ?? null;
        },
        async findByWatchHash(watchHash) {
            const r = await pool.query<PendingSignupRow>('SELECT * FROM pending_signups WHERE watch_hash = ?', [
                watchHash
            ]);
            return r.rows[0] ?? null;
        },
        async markOpened(id, now) {
            await pool.query('UPDATE pending_signups SET opened_at = ? WHERE id = ? AND opened_at IS NULL', [now, id]);
        },
        async markCompleted(id, now) {
            const r = await pool.query(
                'UPDATE pending_signups SET completed_at = ? WHERE id = ? AND completed_at IS NULL AND expires_at > ?',
                [now, id, now]
            );
            return r.rowCount > 0;
        },
        async usernameHeld(username, exceptEmail, now) {
            const r = await pool.query(
                `SELECT 1 FROM pending_signups
                 WHERE username = ? AND email <> ? AND expires_at > ? AND completed_at IS NULL LIMIT 1`,
                [username, exceptEmail, now]
            );
            return r.rows.length > 0;
        },
        async purgeExpired(now) {
            const r = await pool.query(
                `DELETE FROM pending_signups
                 WHERE (completed_at IS NULL AND expires_at <= ?) OR (completed_at IS NOT NULL AND completed_at <= ?)`,
                [now, now - DONE_LINGER_SECONDS]
            );
            return r.rowCount;
        }
    };
}
