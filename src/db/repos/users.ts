import { defaultUserColor, type AdminUser, type UserColor, type UserRow } from '@deveye/types';
import type { Queryable } from '../pool';

type Q = Queryable;

/** Ce qu'un compte montre de lui hors de sa session : ni avatar, ni secret. */
export type AccountRow = Pick<UserRow, 'id' | 'email' | 'username' | 'role' | 'status' | 'e2e_run' | 'created'>;

export interface UsersRepo {
    findById(id: number): Promise<UserRow | null>;
    findByUsername(username: string): Promise<UserRow | null>;
    findByEmail(email: string): Promise<UserRow | null>;
    findByIds(ids: number[]): Promise<UserRow[]>;
    /** Tous les comptes, les plus anciens d'abord, sans avatar ni secret : ce qu'un relevé d'administration lit. */
    all(): Promise<AccountRow[]>;
    /**
     * Les comptes dont le pseudo ou l'adresse contient `query`, par pseudo. Une
     * requête tout en chiffres vise aussi cet id, classé premier. Vide : les
     * premiers comptes.
     */
    search(query: string, limit: number): Promise<UserRow[]>;
    create(input: {
        email: string;
        username: string;
        passwordHash: string;
        role?: 'user' | 'admin';
        /** Secondes : quand les conditions du site ont été acceptées ; `null` sans site. */
        termsAcceptedAt?: number | null;
        /** L'essai de bout en bout qui crée ce compte jetable ; `null` pour une personne. */
        e2eRun?: string | null;
    }): Promise<UserRow>;
    updateLastLogin(id: number, lastLogin: number): Promise<void>;
    /** Rattache le compte à son espace personnel, juste après l'avoir créé. */
    setPersonalWorkspace(id: number, workspaceId: number): Promise<void>;
    /** Espace « favori » chargé en premier ; `null` → l'espace personnel. */
    setDefaultWorkspace(id: number, workspaceId: number | null): Promise<void>;
    updatePasswordHash(id: number, passwordHash: string): Promise<void>;
    updateAvatar(id: number, avatar: string): Promise<void>;
    /** Pseudo du compte : ce avec quoi il se connecte, unique sur tout le site. */
    updateUsername(id: number, username: string): Promise<void>;
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
    /** Les administrateurs en activité, à prévenir quand un compte change. */
    listAdminIds(): Promise<number[]>;
    /** Password re-validation window in seconds; `null` resets to the default. */
    setReAuthInterval(id: number, seconds: number | null): Promise<void>;
    count(): Promise<number>;
    /**
     * En transaction, verrouille la lecture : deux premiers comptes simultanés
     * ne naissent pas tous deux administrateurs.
     */
    countForUpdate(): Promise<number>;
}

/** Échappe ce que LIKE lit comme des jokers, pour qu'un terme reste un terme. */
function likeTerm(term: string): string {
    return `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
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
        async all() {
            const r = await pool.query<AccountRow>(
                'SELECT id, email, username, role, status, e2e_run, created FROM users ORDER BY id ASC'
            );
            return r.rows;
        },
        async search(query, limit) {
            if (query === '') {
                const r = await pool.query<UserRow>('SELECT * FROM users ORDER BY username ASC LIMIT ?', [limit]);
                return r.rows;
            }
            const like = likeTerm(query);
            // L'id ne se compare que pour une requête tout en chiffres : liée en
            // chaîne, « 12abc » vaudrait 12 pour MySQL.
            if (/^\d{1,10}$/.test(query)) {
                const id = Number(query);
                const r = await pool.query<UserRow>(
                    `SELECT * FROM users WHERE id = ? OR username LIKE ? OR email LIKE ?
                     ORDER BY (id = ?) DESC, username ASC LIMIT ?`,
                    [id, like, like, id, limit]
                );
                return r.rows;
            }
            const r = await pool.query<UserRow>(
                'SELECT * FROM users WHERE username LIKE ? OR email LIKE ? ORDER BY username ASC LIMIT ?',
                [like, like, limit]
            );
            return r.rows;
        },
        async create({ email, username, passwordHash, role = 'user', termsAcceptedAt = null, e2eRun = null }) {
            // `personal_workspace_id` est NOT NULL mais l'espace ne peut pas
            // exister avant le compte (FK propriétaire) : 0 le temps de créer
            // l'espace, puis `setPersonalWorkspace` referme le cycle.
            const res = await pool.query(
                `INSERT INTO users (email, username, password_hash, role, settings, personal_workspace_id, terms_accepted_at, e2e_run)
                 VALUES (?, ?, ?, ?, CAST('[]' AS JSON), 0, ?, ?)`,
                [email, username, passwordHash, role, termsAcceptedAt, e2eRun]
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
        async updateUsername(id, username) {
            await pool.query('UPDATE users SET username = ? WHERE id = ?', [username, id]);
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
                e2e_run: string | null;
            }>(
                `SELECT u.id, u.username, u.email, u.avatar, u.role, u.status,
                        (SELECT COUNT(*) FROM workspace_members m WHERE m.user_id = u.id) AS workspace_count,
                        u.last_login, u.created, u.e2e_run
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
                created: Number(x.created),
                test: x.e2e_run !== null
            }));
        },
        async listAdminIds() {
            const r = await pool.query<{ id: number }>(
                "SELECT id FROM users WHERE role = 'admin' AND status = 'active'"
            );
            return r.rows.map((x) => x.id);
        },
        async setReAuthInterval(id, seconds) {
            await pool.query('UPDATE users SET re_auth_interval = ? WHERE id = ?', [seconds, id]);
        },
        async count() {
            const r = await pool.query<{ n: number }>('SELECT COUNT(*) AS n FROM users');
            return Number(r.rows[0].n);
        },
        async countForUpdate() {
            const r = await pool.query<{ n: number }>('SELECT COUNT(*) AS n FROM users FOR UPDATE');
            return Number(r.rows[0].n);
        }
    };
}
