import type { SecrecyWrapMode, UserSecretKeyRow } from '@deveye/types';
import type { Queryable } from '../pool';

type Q = Queryable;

/** Full wrapping state written atomically when the DEK is (re-)wrapped. */
export interface WrapState {
    dekWrapped: string;
    wrapMode: SecrecyWrapMode;
    /** Argon2id salt for the password-derived key (null in `server` mode). */
    kdfSalt: Buffer | null;
    /** Recovery copy of the DEK (null when no recovery code is set). */
    recoveryWrapped: string | null;
    recoverySalt: Buffer | null;
}

export interface UserSecretKeysRepo {
    get(userId: number): Promise<UserSecretKeyRow | null>;
    /** Create the row with a freshly generated, server-wrapped DEK. */
    create(userId: number, dekWrapped: string): Promise<void>;
    /** Replace the wrapping (and recovery material) in one statement. */
    setWrap(userId: number, state: WrapState): Promise<void>;
    /**
     * Store the user's open DEK on first use. Only ever writes when the column
     * is still NULL, so two concurrent first writes can't orphan each other's
     * ciphertext; the caller re-reads the row to learn which one won.
     */
    setOpenDek(userId: number, openDekWrapped: string): Promise<void>;
}

export function userSecretKeysRepo(pool: Q): UserSecretKeysRepo {
    return {
        async get(userId) {
            const r = await pool.query<UserSecretKeyRow>('SELECT * FROM user_secret_keys WHERE user_id = ?', [userId]);
            return r.rows[0] ?? null;
        },
        async create(userId, dekWrapped) {
            // INSERT IGNORE: the DEK is created lazily and concurrent first
            // writes must not clobber an existing DEK (which would orphan all
            // previously encrypted content).
            await pool.query(
                `INSERT IGNORE INTO user_secret_keys (user_id, dek_wrapped, wrap_mode)
                 VALUES (?, ?, 'server')`,
                [userId, dekWrapped]
            );
        },
        async setWrap(userId, state) {
            const now = Math.floor(Date.now() / 1000);
            await pool.query(
                `UPDATE user_secret_keys
                 SET dek_wrapped = ?, wrap_mode = ?, kdf_salt = ?,
                     recovery_wrapped = ?, recovery_salt = ?, updated = ?
                 WHERE user_id = ?`,
                [
                    state.dekWrapped,
                    state.wrapMode,
                    state.kdfSalt,
                    state.recoveryWrapped,
                    state.recoverySalt,
                    now,
                    userId
                ]
            );
        },
        async setOpenDek(userId, openDekWrapped) {
            await pool.query(
                `UPDATE user_secret_keys SET open_dek_wrapped = ?, updated = ?
                 WHERE user_id = ? AND open_dek_wrapped IS NULL`,
                [openDekWrapped, Math.floor(Date.now() / 1000), userId]
            );
        }
    };
}
