import type { Queryable } from '../pool';

export interface UserPhoneRow {
    user_id: number;
    /** Le numéro au format international, scellé par la clé serveur (`phoneContext`). */
    phone_sealed: string;
    verified_at: number;
    sms_check: number;
}

export interface UserPhonesRepo {
    get(userId: number): Promise<UserPhoneRow | null>;
    /** Un numéro qui vient d'être vérifié remplace le précédent, code par SMS allumé. */
    save(userId: number, sealed: string, verifiedAt: number): Promise<void>;
    setSmsCheck(userId: number, enabled: boolean): Promise<void>;
    remove(userId: number): Promise<void>;
}

export function userPhonesRepo(pool: Queryable): UserPhonesRepo {
    return {
        async get(userId) {
            const r = await pool.query<UserPhoneRow>('SELECT * FROM user_phones WHERE user_id = ?', [userId]);
            return r.rows[0] ?? null;
        },
        async save(userId, sealed, verifiedAt) {
            await pool.query(
                `INSERT INTO user_phones (user_id, phone_sealed, verified_at, sms_check) VALUES (?, ?, ?, 1)
                 ON DUPLICATE KEY UPDATE phone_sealed = VALUES(phone_sealed), verified_at = VALUES(verified_at),
                     sms_check = 1`,
                [userId, sealed, verifiedAt]
            );
        },
        async setSmsCheck(userId, enabled) {
            await pool.query('UPDATE user_phones SET sms_check = ? WHERE user_id = ?', [enabled ? 1 : 0, userId]);
        },
        async remove(userId) {
            await pool.query('DELETE FROM user_phones WHERE user_id = ?', [userId]);
        }
    };
}
