import { defaultUserColor, type AdminUser, type UserColor, type UserRow } from '@deveye/types';
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
    /** Couleur d'identité du compte, montrée aux autres membres en direct. */
    updateColor(id: number, color: UserColor): Promise<void>;
    /** Remplace le sac de drapeaux du compte (`userSettingFlagSchema`). */
    updateSettings(id: number, settings: string[]): Promise<void>;
    setRole(id: number, role: 'user' | 'admin'): Promise<void>;
    setStatus(id: number, status: 'active' | 'suspended'): Promise<void>;
    /** Supprime le compte ; les FK CASCADE emportent ses espaces et leur contenu. */
    delete(id: number): Promise<void>;
    /** Vue de la page Utilisateurs : le compte, plus son nombre d'espaces. */
    listForAdmin(): Promise<AdminUser[]>;
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
            // exister avant le compte (FK propriétaire) : 0 le temps de créer
            // l'espace, puis `setPersonalWorkspace` referme le cycle.
            const res = await pool.query(
                `INSERT INTO users (email, username, password_hash, role, settings, personal_workspace_id)
                 VALUES (?, ?, ?, ?, CAST('[]' AS JSON), 0)`,
                [email, username, passwordHash, role]
            );
            // La colonne a un défaut vide : un compte neuf prend sa teinte ici.
            await pool.query('UPDATE users SET color = ? WHERE id = ?', [
                defaultUserColor(Number(res.insertId)),
                res.insertId
            ]);
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
        async updateColor(id, color) {
            await pool.query('UPDATE users SET color = ? WHERE id = ?', [color, id]);
        },
        async updateSettings(id, settings) {
            await pool.query('UPDATE users SET settings = ? WHERE id = ?', [JSON.stringify(settings), id]);
        },
        async setRole(id, role) {
            await pool.query('UPDATE users SET role = ? WHERE id = ?', [role, id]);
        },
        async setStatus(id, status) {
            await pool.query('UPDATE users SET status = ? WHERE id = ?', [status, id]);
        },
        async delete(id) {
            await pool.query('DELETE FROM users WHERE id = ?', [id]);
        },
        async listForAdmin() {
            const r = await pool.query<{
                id: number;
                username: string;
                email: string;
                avatar: string;
                role: string;
                status: string;
                workspace_count: number;
                last_login: number;
                created: number;
            }>(
                `SELECT u.id, u.username, u.email, u.avatar, u.role, u.status,
                        (SELECT COUNT(*) FROM workspace_members m WHERE m.user_id = u.id) AS workspace_count,
                        u.last_login, u.created
                 FROM users u ORDER BY u.created ASC`
            );
            return r.rows.map((x) => ({
                id: x.id,
                username: x.username,
                email: x.email,
                avatar: x.avatar,
                role: x.role === 'admin' ? ('admin' as const) : ('user' as const),
                status: x.status === 'suspended' ? ('suspended' as const) : ('active' as const),
                workspaceCount: Number(x.workspace_count),
                lastLogin: Number(x.last_login),
                created: Number(x.created)
            }));
        },
        async setReAuthInterval(id, seconds) {
            await pool.query('UPDATE users SET re_auth_interval = ? WHERE id = ?', [seconds, id]);
        }
    };
}
