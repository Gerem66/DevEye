import type { WorkspaceMemberRow, WorkspaceRow } from 'deveye-types';
import type { Queryable } from '../pool';

type Q = Queryable;

export interface WorkspacesRepo {
    findById(id: number): Promise<WorkspaceRow | null>;
    findAccessibleByUser(userId: number): Promise<WorkspaceRow[]>;
    create(input: { name: string }): Promise<WorkspaceRow>;
    delete(id: number): Promise<void>;
    updateFeatures(id: number, features: string[]): Promise<void>;
}

export function workspacesRepo(pool: Q): WorkspacesRepo {
    return {
        async findById(id) {
            const r = await pool.query<WorkspaceRow>('SELECT * FROM workspaces WHERE id = ?', [id]);
            return r.rows[0] ?? null;
        },
        async findAccessibleByUser(userId) {
            const r = await pool.query<WorkspaceRow>(
                `SELECT w.* FROM workspaces w
                 INNER JOIN workspace_members m ON m.workspace_id = w.id
                 WHERE m.user_id = ?
                 ORDER BY w.id ASC`,
                [userId]
            );
            return r.rows;
        },
        async create({ name }) {
            const res = await pool.query('INSERT INTO workspaces (name) VALUES (?)', [name]);
            const r = await pool.query<WorkspaceRow>('SELECT * FROM workspaces WHERE id = ?', [res.insertId]);
            return r.rows[0];
        },
        async delete(id) {
            await pool.query('DELETE FROM workspaces WHERE id = ?', [id]);
        },
        async updateFeatures(id, features) {
            await pool.query('UPDATE workspaces SET features = ? WHERE id = ?', [JSON.stringify(features), id]);
        }
    };
}

export interface WorkspaceMembersRepo {
    listByWorkspaceIds(workspaceIds: number[]): Promise<WorkspaceMemberRow[]>;
    add(input: { userId: number; workspaceId: number; roles?: string[] }): Promise<WorkspaceMemberRow>;
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
        async add({ userId, workspaceId, roles = [] }) {
            const res = await pool.query(
                `INSERT INTO workspace_members (user_id, workspace_id, roles)
                 VALUES (?, ?, ?)`,
                [userId, workspaceId, JSON.stringify(roles)]
            );
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
