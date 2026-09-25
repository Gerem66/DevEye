import type { WorkspaceMemberRow, WorkspaceRow } from '@deveye/types';
import type { Queryable } from '../pool';

type Q = Queryable;

export interface WorkspacesRepo {
    findById(id: number): Promise<WorkspaceRow | null>;
    /** Espaces dont l'utilisateur est membre, personnel d'abord puis par ancienneté. */
    findAccessibleByUser(userId: number): Promise<WorkspaceRow[]>;
    /**
     * Tous les espaces, appartenance ignorée. Réservé à l'administration de la
     * flotte, qui propose le partage vers un espace dont l'admin n'est pas membre.
     */
    listAll(): Promise<WorkspaceRow[]>;
    /** Les espaces dont ce compte est propriétaire, personnel compris. */
    listOwnedIds(ownerUserId: number): Promise<number[]>;
    /** Ses espaces partagés, du plus ancien au plus récent : l'ordre où l'offre les garde ouverts. */
    listOwnedShared(ownerUserId: number): Promise<{ id: number }[]>;
    /** Tous les comptes qui possèdent un espace. */
    listOwnerIds(): Promise<number[]>;
    /** Crée l'espace personnel d'un compte (un seul par compte) et y inscrit son propriétaire. */
    createPersonal(ownerUserId: number, name: string): Promise<WorkspaceRow>;
    create(input: { ownerUserId: number; name: string }): Promise<WorkspaceRow>;
    rename(id: number, name: string): Promise<void>;
    delete(id: number): Promise<void>;
    updateFeatures(id: number, features: string[]): Promise<void>;
    setTheme(id: number, theme: string): Promise<void>;
    setHomeLayout(id: number, homeLayout: string): Promise<void>;
}

/**
 * Colonnes de `workspaces` hors `theme` / `home_layout` : deux MEDIUMTEXT qui
 * peuvent contenir des fonds d'écran en base64. On ne les rapatrie que quand on
 * en a besoin, jamais dans un listage d'espaces.
 */
const LIST_COLUMNS = 'w.id, w.kind, w.name, w.logo, w.owner_user_id, w.features, w.created';

export function workspacesRepo(pool: Q): WorkspacesRepo {
    return {
        async findById(id) {
            const r = await pool.query<WorkspaceRow>('SELECT * FROM workspaces WHERE id = ?', [id]);
            return r.rows[0] ?? null;
        },
        async findAccessibleByUser(userId) {
            // L'espace personnel en tête : c'est le repli implicite et la
            // première entrée du sélecteur.
            const r = await pool.query<WorkspaceRow>(
                `SELECT ${LIST_COLUMNS} FROM workspaces w
                 INNER JOIN workspace_members m ON m.workspace_id = w.id
                 WHERE m.user_id = ?
                 ORDER BY w.kind = 'personal' DESC, w.created ASC, w.id ASC`,
                [userId]
            );
            return r.rows;
        },
        async listOwnedIds(ownerUserId) {
            const r = await pool.query<{ id: number }>('SELECT id FROM workspaces WHERE owner_user_id = ?', [
                ownerUserId
            ]);
            return r.rows.map((row) => Number(row.id));
        },
        async listOwnedShared(ownerUserId) {
            const r = await pool.query<{ id: number }>(
                "SELECT id FROM workspaces WHERE owner_user_id = ? AND kind = 'shared' ORDER BY created ASC, id ASC",
                [ownerUserId]
            );
            return r.rows.map((row) => ({ id: Number(row.id) }));
        },
        async listOwnerIds() {
            const r = await pool.query<{ owner_user_id: number }>('SELECT DISTINCT owner_user_id FROM workspaces');
            return r.rows.map((row) => Number(row.owner_user_id));
        },
        async listAll() {
            const r = await pool.query<WorkspaceRow>(
                `SELECT ${LIST_COLUMNS} FROM workspaces w
                 ORDER BY w.kind = 'personal' DESC, w.name ASC, w.id ASC`
            );
            return r.rows;
        },
        async createPersonal(ownerUserId, name) {
            return insertWorkspace(pool, 'personal', ownerUserId, name);
        },
        async create({ ownerUserId, name }) {
            return insertWorkspace(pool, 'shared', ownerUserId, name);
        },
        async rename(id, name) {
            await pool.query('UPDATE workspaces SET name = ? WHERE id = ?', [name, id]);
        },
        async delete(id) {
            // Les FK ON DELETE CASCADE emportent membres et contenu, sauf
            // `deploy_targets` et `git_repos`, retirés à la main avant : leur
            // `credential_id ... ON DELETE SET NULL` vise une table que la même
            // cascade détruit, et InnoDB revalide alors la ligne enfant contre
            // son espace en cours de suppression et refuse (errno 1452).
            await pool.query('DELETE FROM deploy_targets WHERE workspace_id = ?', [id]);
            await pool.query('DELETE FROM git_repos WHERE workspace_id = ?', [id]);
            await pool.query('DELETE FROM workspaces WHERE id = ?', [id]);
        },
        async updateFeatures(id, features) {
            await pool.query('UPDATE workspaces SET features = ? WHERE id = ?', [JSON.stringify(features), id]);
        },
        async setTheme(id, theme) {
            await pool.query('UPDATE workspaces SET theme = ? WHERE id = ?', [theme, id]);
        },
        async setHomeLayout(id, homeLayout) {
            await pool.query('UPDATE workspaces SET home_layout = ? WHERE id = ?', [homeLayout, id]);
        }
    };
}

/**
 * Insère l'espace et y inscrit aussitôt son propriétaire comme membre : tout
 * accès passe par `workspace_members`, espace personnel compris.
 */
async function insertWorkspace(
    pool: Q,
    kind: 'personal' | 'shared',
    ownerUserId: number,
    name: string
): Promise<WorkspaceRow> {
    const res = await pool.query(
        `INSERT INTO workspaces (kind, name, owner_user_id, features)
         VALUES (?, ?, ?, CAST('[]' AS JSON))`,
        [kind, name, ownerUserId]
    );
    const id = res.insertId;
    await pool.query('INSERT INTO workspace_members (user_id, workspace_id) VALUES (?, ?)', [ownerUserId, id]);
    const r = await pool.query<WorkspaceRow>('SELECT * FROM workspaces WHERE id = ?', [id]);
    return r.rows[0];
}

export interface WorkspaceMembersRepo {
    listByWorkspaceIds(workspaceIds: number[]): Promise<WorkspaceMemberRow[]>;
    add(input: { userId: number; workspaceId: number }): Promise<WorkspaceMemberRow>;
    remove(userId: number, workspaceId: number): Promise<void>;
    isMember(userId: number, workspaceId: number): Promise<boolean>;
}

export function workspaceMembersRepo(pool: Q): WorkspaceMembersRepo {
    return {
        async listByWorkspaceIds(workspaceIds) {
            if (workspaceIds.length === 0) return [];
            const r = await pool.query<WorkspaceMemberRow>(
                'SELECT * FROM workspace_members WHERE workspace_id IN (?)',
                [workspaceIds]
            );
            return r.rows;
        },
        async add({ userId, workspaceId }) {
            const res = await pool.query('INSERT INTO workspace_members (user_id, workspace_id) VALUES (?, ?)', [
                userId,
                workspaceId
            ]);
            const r = await pool.query<WorkspaceMemberRow>('SELECT * FROM workspace_members WHERE id = ?', [
                res.insertId
            ]);
            return r.rows[0];
        },
        async remove(userId, workspaceId) {
            await pool.query('DELETE FROM workspace_members WHERE user_id = ? AND workspace_id = ?', [
                userId,
                workspaceId
            ]);
        },
        async isMember(userId, workspaceId) {
            const r = await pool.query<{ count: number }>(
                'SELECT COUNT(*) AS count FROM workspace_members WHERE user_id = ? AND workspace_id = ?',
                [userId, workspaceId]
            );
            return Number(r.rows[0].count) > 0;
        }
    };
}
