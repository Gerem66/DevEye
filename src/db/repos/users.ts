import type { UserRow } from 'deveye-types';
import type { Queryable } from '../pool';

type Q = Queryable;

export interface UsersRepo {
    findById(id: number): Promise<UserRow | null>;
    findByUsername(username: string): Promise<UserRow | null>;
    findByEmail(email: string): Promise<UserRow | null>;
    findByIds(ids: number[]): Promise<UserRow[]>;
    create(input: {
        email: string;
        username: string;
        passwordHash: string;
    }): Promise<UserRow>;
    updateLastLogin(id: number, lastLogin: number): Promise<void>;
    setDefaults(id: number, defaults: { defaultWorkspace: number; defaultFeature: string }): Promise<void>;
    updatePasswordHash(id: number, passwordHash: string): Promise<void>;
}

export function usersRepo(pool: Q): UsersRepo {
    return {
        async findById(id) {
            const r = await pool.query<UserRow>('SELECT * FROM users WHERE id = ?', [id]);
            return r.rows[0] ?? null;
        },
        async findByUsername(username) {
            const r = await pool.query<UserRow>('SELECT * FROM users WHERE username = ?', [username]);
            return r.rows[0] ?? null;
        },
        async findByEmail(email) {
            const r = await pool.query<UserRow>('SELECT * FROM users WHERE email = ?', [email]);
            return r.rows[0] ?? null;
        },
        async findByIds(ids) {
            if (ids.length === 0) return [];
            const r = await pool.query<UserRow>('SELECT * FROM users WHERE id IN (?)', [ids]);
            return r.rows;
        },
        async create({ email, username, passwordHash }) {
            const res = await pool.query(
                `INSERT INTO users (email, username, password_hash)
                 VALUES (?, ?, ?)`,
                [email, username, passwordHash]
            );
            const r = await pool.query<UserRow>('SELECT * FROM users WHERE id = ?', [res.insertId]);
            return r.rows[0];
        },
        async updateLastLogin(id, lastLogin) {
            await pool.query('UPDATE users SET last_login = ? WHERE id = ?', [lastLogin, id]);
        },
        async setDefaults(id, { defaultWorkspace, defaultFeature }) {
            await pool.query(
                'UPDATE users SET default_workspace = ?, default_feature = ? WHERE id = ?',
                [defaultWorkspace, defaultFeature, id]
            );
        },
        async updatePasswordHash(id, passwordHash) {
            await pool.query('UPDATE users SET password_hash = ? WHERE id = ?', [passwordHash, id]);
        }
    };
}
