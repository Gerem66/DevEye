import type { PasswordRow } from '@deveye/types';
import type { Queryable } from '../pool';

type Q = Queryable;

/**
 * Les entrées appartiennent à un **espace**, pas à un compte : c'est
 * `workspace_id` qui cloisonne. `user_id` est conservé pour dire qui a créé la
 * ligne (attribution dans un espace partagé), jamais pour contrôler l'accès.
 */
export interface PasswordsRepo {
    listByWorkspace(workspaceId: number): Promise<PasswordRow[]>;
    countByWorkspace(workspaceId: number): Promise<number>;
    findById(id: number, workspaceId: number): Promise<PasswordRow | null>;
    create(input: { userId: number; workspaceId: number; content: string }): Promise<PasswordRow>;
    update(id: number, workspaceId: number, content: string): Promise<PasswordRow | null>;
    delete(id: number, workspaceId: number): Promise<boolean>;
}

export function passwordsRepo(pool: Q): PasswordsRepo {
    return {
        async listByWorkspace(workspaceId) {
            const r = await pool.query<PasswordRow>('SELECT * FROM passwords WHERE workspace_id = ? ORDER BY id ASC', [
                workspaceId
            ]);
            return r.rows;
        },
        async countByWorkspace(workspaceId) {
            const r = await pool.query<{ count: number }>(
                'SELECT COUNT(*) AS count FROM passwords WHERE workspace_id = ?',
                [workspaceId]
            );
            return Number(r.rows[0]?.count ?? 0);
        },
        async findById(id, workspaceId) {
            const r = await pool.query<PasswordRow>('SELECT * FROM passwords WHERE id = ? AND workspace_id = ?', [
                id,
                workspaceId
            ]);
            return r.rows[0] ?? null;
        },
        async create({ userId, workspaceId, content }) {
            const res = await pool.query(
                `INSERT INTO passwords (user_id, workspace_id, content)
                 VALUES (?, ?, ?)`,
                [userId, workspaceId, content]
            );
            const r = await pool.query<PasswordRow>('SELECT * FROM passwords WHERE id = ?', [res.insertId]);
            return r.rows[0];
        },
        async update(id, workspaceId, content) {
            const res = await pool.query('UPDATE passwords SET content = ? WHERE id = ? AND workspace_id = ?', [
                content,
                id,
                workspaceId
            ]);
            if (res.rowCount === 0) return null;
            const r = await pool.query<PasswordRow>('SELECT * FROM passwords WHERE id = ? AND workspace_id = ?', [
                id,
                workspaceId
            ]);
            return r.rows[0] ?? null;
        },
        async delete(id, workspaceId) {
            const r = await pool.query('DELETE FROM passwords WHERE id = ? AND workspace_id = ?', [id, workspaceId]);
            return r.rowCount > 0;
        }
    };
}
