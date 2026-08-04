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
    /** Rattache le compte à son espace personnel, juste après l'avoir créé. */
    setPersonalWorkspace(id: number, workspaceId: number): Promise<void>;
    /** Espace « favori » chargé en premier ; `null` → l'espace personnel. */
    setDefaultWorkspace(id: number, workspaceId: number | null): Promise<void>;
    updatePasswordHash(id: number, passwordHash: string): Promise<void>;
    updateAvatar(id: number, avatar: string): Promise<void>;
    setRole(id: number, role: 'user' | 'admin'): Promise<void>;
    /** Password re-validation window in seconds; `null` resets to the default. */
    setReAuthInterval(id: number, seconds: number | null): Promise<void>;
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
            // `personal_workspace_id` est NOT NULL mais l'espace ne peut pas
            // exister avant le compte (sa FK propriétaire le référence) : on pose
            // 0 le temps de créer l'espace, puis `setPersonalWorkspace` referme
            // le cycle. L'appelant unique de `create` est l'inscription, qui
            // enchaîne les deux — voir `auth/routes.ts`.
            const res = await pool.query(
                `INSERT INTO users (email, username, password_hash, role, settings, personal_workspace_id)
                 VALUES (?, ?, ?, ?, CAST('[]' AS JSON), 0)`,
                [email, username, passwordHash, role]
            );
            const r = await pool.query<UserRow>('SELECT * FROM users WHERE id = ?', [res.insertId]);
            return r.rows[0];
        },
        async updateLastLogin(id, lastLogin) {
            await pool.query('UPDATE users SET last_login = ? WHERE id = ?', [lastLogin, id]);
        },
        async setPersonalWorkspace(id, workspaceId) {
            await pool.query('UPDATE users SET personal_workspace_id = ? WHERE id = ?', [workspaceId, id]);
        },
        async setDefaultWorkspace(id, workspaceId) {
            await pool.query('UPDATE users SET default_workspace_id = ? WHERE id = ?', [workspaceId, id]);
        },
        async updatePasswordHash(id, passwordHash) {
            await pool.query('UPDATE users SET password_hash = ? WHERE id = ?', [passwordHash, id]);
        },
        async updateAvatar(id, avatar) {
            await pool.query('UPDATE users SET avatar = ? WHERE id = ?', [avatar, id]);
        },
        async setRole(id, role) {
            await pool.query('UPDATE users SET role = ? WHERE id = ?', [role, id]);
        },
        async setReAuthInterval(id, seconds) {
            await pool.query('UPDATE users SET re_auth_interval = ? WHERE id = ?', [seconds, id]);
        }
    };
}
