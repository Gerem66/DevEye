import type { WorkspaceCapability, WorkspaceFeatureGrant, WorkspaceRoleRow } from '@deveye/types';
import type { Queryable } from '../pool';

type Q = Queryable;

export interface RoleInput {
    name: string;
    color: string;
    capabilities: WorkspaceCapability[];
    features: WorkspaceFeatureGrant[];
}

export interface WorkspaceRolesRepo {
    listByWorkspace(workspaceId: number): Promise<WorkspaceRoleRow[]>;
    findById(id: number, workspaceId: number): Promise<WorkspaceRoleRow | null>;
    /** Rôle d'un membre, ou `null` s'il n'en a pas (donc aucun droit). */
    findForMember(userId: number, workspaceId: number): Promise<WorkspaceRoleRow | null>;
    /** Rôle attribué d'office à qui rejoint l'espace. */
    findDefault(workspaceId: number): Promise<WorkspaceRoleRow | null>;
    create(workspaceId: number, input: RoleInput): Promise<WorkspaceRoleRow>;
    update(id: number, workspaceId: number, input: RoleInput): Promise<WorkspaceRoleRow | null>;
    delete(id: number, workspaceId: number): Promise<boolean>;
    /** Combien de membres portent ce rôle — le refus de suppression s'appuie dessus. */
    memberCount(roleId: number): Promise<number>;
    setDefault(workspaceId: number, roleId: number): Promise<void>;
    assign(userId: number, workspaceId: number, roleId: number | null): Promise<void>;
    reorder(workspaceId: number, ids: number[]): Promise<void>;
    /** Quel membre porte quel rôle, pour l'écran de gestion. */
    memberRoles(workspaceId: number): Promise<{ userId: number; roleId: number | null }[]>;
}

export function workspaceRolesRepo(pool: Q): WorkspaceRolesRepo {
    const cols = 'id, workspace_id, name, color, position, capabilities, features, is_default, created';

    return {
        async listByWorkspace(workspaceId) {
            const r = await pool.query<WorkspaceRoleRow>(
                `SELECT ${cols} FROM workspace_roles WHERE workspace_id = ? ORDER BY position ASC, id ASC`,
                [workspaceId]
            );
            return r.rows;
        },
        async findById(id, workspaceId) {
            const r = await pool.query<WorkspaceRoleRow>(
                `SELECT ${cols} FROM workspace_roles WHERE id = ? AND workspace_id = ?`,
                [id, workspaceId]
            );
            return r.rows[0] ?? null;
        },
        async findForMember(userId, workspaceId) {
            const r = await pool.query<WorkspaceRoleRow>(
                `SELECT r.id, r.workspace_id, r.name, r.color, r.position, r.capabilities, r.features,
                        r.is_default, r.created
                 FROM workspace_members m
                 INNER JOIN workspace_roles r ON r.id = m.role_id
                 WHERE m.user_id = ? AND m.workspace_id = ?`,
                [userId, workspaceId]
            );
            return r.rows[0] ?? null;
        },
        async findDefault(workspaceId) {
            const r = await pool.query<WorkspaceRoleRow>(
                `SELECT ${cols} FROM workspace_roles WHERE workspace_id = ? AND is_default = 1 LIMIT 1`,
                [workspaceId]
            );
            return r.rows[0] ?? null;
        },
        async create(workspaceId, { name, color, capabilities, features }) {
            const posRow = await pool.query<{ next: number }>(
                'SELECT COALESCE(MAX(position) + 1, 0) AS next FROM workspace_roles WHERE workspace_id = ?',
                [workspaceId]
            );
            const res = await pool.query(
                `INSERT INTO workspace_roles (workspace_id, name, color, position, capabilities, features)
                 VALUES (?, ?, ?, ?, CAST(? AS JSON), CAST(? AS JSON))`,
                [
                    workspaceId,
                    name,
                    color,
                    Number(posRow.rows[0]?.next ?? 0),
                    JSON.stringify(capabilities),
                    JSON.stringify(features)
                ]
            );
            const row = await this.findById(res.insertId, workspaceId);
            if (!row) throw new Error('Failed to create workspace role');
            return row;
        },
        async update(id, workspaceId, { name, color, capabilities, features }) {
            const res = await pool.query(
                `UPDATE workspace_roles
                 SET name = ?, color = ?, capabilities = CAST(? AS JSON), features = CAST(? AS JSON)
                 WHERE id = ? AND workspace_id = ?`,
                [name, color, JSON.stringify(capabilities), JSON.stringify(features), id, workspaceId]
            );
            if (res.rowCount === 0 && !(await this.findById(id, workspaceId))) return null;
            return this.findById(id, workspaceId);
        },
        async delete(id, workspaceId) {
            const r = await pool.query('DELETE FROM workspace_roles WHERE id = ? AND workspace_id = ?', [
                id,
                workspaceId
            ]);
            return r.rowCount > 0;
        },
        async memberCount(roleId) {
            const r = await pool.query<{ n: number }>('SELECT COUNT(*) AS n FROM workspace_members WHERE role_id = ?', [
                roleId
            ]);
            return Number(r.rows[0]?.n ?? 0);
        },
        async setDefault(workspaceId, roleId) {
            // Une seule instruction : impossible de se retrouver avec zéro ou
            // deux rôles par défaut, même sans transaction.
            await pool.query('UPDATE workspace_roles SET is_default = (id = ?) WHERE workspace_id = ?', [
                roleId,
                workspaceId
            ]);
        },
        async assign(userId, workspaceId, roleId) {
            await pool.query('UPDATE workspace_members SET role_id = ? WHERE user_id = ? AND workspace_id = ?', [
                roleId,
                userId,
                workspaceId
            ]);
        },
        async memberRoles(workspaceId) {
            const r = await pool.query<{ user_id: number; role_id: number | null }>(
                'SELECT user_id, role_id FROM workspace_members WHERE workspace_id = ?',
                [workspaceId]
            );
            return r.rows.map((x) => ({ userId: x.user_id, roleId: x.role_id }));
        },
        async reorder(workspaceId, ids) {
            for (let i = 0; i < ids.length; i++) {
                await pool.query('UPDATE workspace_roles SET position = ? WHERE id = ? AND workspace_id = ?', [
                    i,
                    ids[i],
                    workspaceId
                ]);
            }
        }
    };
}
