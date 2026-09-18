import type { BackupCodeRow, TwoFactorRow } from '@deveye/types';
import type { Queryable } from '../pool';

type Q = Queryable;

export interface TwoFactorRepo {
    get(userId: number): Promise<TwoFactorRow | null>;
    upsertSecret(userId: number, secretEnc: string): Promise<void>;
    enable(userId: number): Promise<void>;
    disable(userId: number): Promise<void>;
    replaceBackupCodes(userId: number, codeHashes: string[]): Promise<void>;
    countUnusedBackupCodes(userId: number): Promise<number>;
    findUnusedBackupCode(userId: number, codeHash: string): Promise<BackupCodeRow | null>;
    /** Burn the code; false when it was already burnt by a concurrent use. */
    markBackupCodeUsed(id: number): Promise<boolean>;
    /**
     * Record the TOTP step just accepted, only if it is later than the last one:
     * false means the step was already claimed, by a replay or a concurrent
     * submission of the same code.
     */
    claimTotpCounter(userId: number, counter: number): Promise<boolean>;
}

export function twoFactorRepo(pool: Q): TwoFactorRepo {
    return {
        async get(userId) {
            const r = await pool.query<TwoFactorRow>('SELECT * FROM user_2fa WHERE user_id = ?', [userId]);
            return r.rows[0] ?? null;
        },
        async upsertSecret(userId, secretEnc) {
            await pool.query(
                `INSERT INTO user_2fa (user_id, secret_enc, enabled)
                 VALUES (?, ?, 0)
                 ON DUPLICATE KEY UPDATE secret_enc = VALUES(secret_enc), enabled = 0, confirmed_at = NULL`,
                [userId, secretEnc]
            );
        },
        async enable(userId) {
            const now = Math.floor(Date.now() / 1000);
            await pool.query('UPDATE user_2fa SET enabled = 1, confirmed_at = ? WHERE user_id = ?', [now, userId]);
        },
        async disable(userId) {
            await pool.query('DELETE FROM user_2fa WHERE user_id = ?', [userId]);
            await pool.query('DELETE FROM user_2fa_backup_codes WHERE user_id = ?', [userId]);
        },
        async replaceBackupCodes(userId, codeHashes) {
            await pool.query('DELETE FROM user_2fa_backup_codes WHERE user_id = ?', [userId]);
            if (codeHashes.length === 0) return;
            const values = codeHashes.map(() => '(?, ?)').join(', ');
            const params: unknown[] = [];
            for (const h of codeHashes) params.push(userId, h);
            await pool.query(`INSERT INTO user_2fa_backup_codes (user_id, code_hash) VALUES ${values}`, params);
        },
        async countUnusedBackupCodes(userId) {
            const r = await pool.query<{ n: number }>(
                'SELECT COUNT(*) AS n FROM user_2fa_backup_codes WHERE user_id = ? AND used_at IS NULL',
                [userId]
            );
            return Number(r.rows[0]?.n ?? 0);
        },
        async findUnusedBackupCode(userId, codeHash) {
            const r = await pool.query<BackupCodeRow>(
                'SELECT * FROM user_2fa_backup_codes WHERE user_id = ? AND code_hash = ? AND used_at IS NULL',
                [userId, codeHash]
            );
            return r.rows[0] ?? null;
        },
        async markBackupCodeUsed(id) {
            const now = Math.floor(Date.now() / 1000);
            const res = await pool.query(
                'UPDATE user_2fa_backup_codes SET used_at = ? WHERE id = ? AND used_at IS NULL',
                [now, id]
            );
            return res.rowCount === 1;
        },
        async claimTotpCounter(userId, counter) {
            const res = await pool.query(
                `UPDATE user_2fa SET last_used_counter = ?
                 WHERE user_id = ? AND (last_used_counter IS NULL OR last_used_counter < ?)`,
                [counter, userId, counter]
            );
            return res.rowCount === 1;
        }
    };
}
