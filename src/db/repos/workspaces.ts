import type { WorkspaceMemberRow, WorkspaceRow } from 'deveye-types';
import type { Queryable } from '../pool';

type Q = Queryable;

export interface WorkspacesRepo {
    findById(id: number): Promise<WorkspaceRow | null>;
    /** Espaces dont l'utilisateur est membre, personnel d'abord puis par ancienneté. */
    findAccessibleByUser(userId: number): Promise<WorkspaceRow[]>;
    /**
     * Crée l'espace personnel d'un compte et y inscrit son propriétaire.
     * Appelé une seule fois, à l'inscription : tout compte a exactement un espace
     * personnel (contrainte `users.uniq_personal_workspace`).
     */
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
            // Les FK ON DELETE CASCADE emportent les membres et tout le contenu.
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
 * Insère l'espace et y inscrit aussitôt son propriétaire comme membre.
 *
 * L'adhésion n'est pas optionnelle : l'invariant du modèle est que **tout** accès
 * passe par `workspace_members`, espace personnel compris. Sans elle, un
 * propriétaire ne verrait pas son propre espace dans `findAccessibleByUser`.
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
