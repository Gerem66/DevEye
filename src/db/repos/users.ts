import type { UserRow } from 'deveye-types';
import type { Queryable } from '../pool';

type Q = Queryable;

export interface UsersRepo {
    findById(id: number): Promise<UserRow | null>;
    findByUsername(username: string): Promise<UserRow | null>;
    findByEmail(email: string): Promise<UserRow | null>;
    findByIds(ids: number[]): Promise<UserRow[]>;
    create(input: { email: string; username: string; passwordHash: string; role?: 'user' | 'admin' }): Promise<UserRow>;
    updateLastLogin(id: number, lastLogin: number): Promise<void>;
    setDefaultWorkspace(id: number, defaultWorkspace: number): Promise<void>;
    updatePasswordHash(id: number, passwordHash: string): Promise<void>;
    setRole(id: number, role: 'user' | 'admin'): Promise<void>;
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
        async create({ email, username, passwordHash, role = 'user' }) {
            const res = await pool.query(
                `INSERT INTO users (email, username, password_hash, role, settings, features)
                 VALUES (?, ?, ?, ?, CAST('[]' AS JSON), CAST('[]' AS JSON))`,
                [email, username, passwordHash, role]
            );
            const r = await pool.query<UserRow>('SELECT * FROM users WHERE id = ?', [res.insertId]);
            return r.rows[0];
        },
        async updateLastLogin(id, lastLogin) {
            await pool.query('UPDATE users SET last_login = ? WHERE id = ?', [lastLogin, id]);
        },
        async setDefaultWorkspace(id, defaultWorkspace) {
            await pool.query('UPDATE users SET default_workspace = ? WHERE id = ?', [defaultWorkspace, id]);
        },
        async updatePasswordHash(id, passwordHash) {
            await pool.query('UPDATE users SET password_hash = ? WHERE id = ?', [passwordHash, id]);
        },
        async setRole(id, role) {
            await pool.query('UPDATE users SET role = ? WHERE id = ?', [role, id]);
        }
    };
}
