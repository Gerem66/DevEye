import type { PasswordRow } from '../contracts/domain';
import type { SdkQueryable } from '@deveye/types/sdk/server';

/**
 * Les entrées appartiennent à un **espace**, pas à un compte : c'est
 * `workspace_id` qui cloisonne. `user_id` est conservé pour dire qui a créé la
 * ligne (attribution dans un espace partagé), jamais pour contrôler l'accès.
 */
export interface PasswordRepo {
    listByWorkspace(workspaceId: number): Promise<PasswordRow[]>;
    countByWorkspace(workspaceId: number): Promise<number>;
    findById(id: number, workspaceId: number): Promise<PasswordRow | null>;
    /** `content` est déjà chiffré par l'appelant (`ctx.cipher('private')`). Le dépôt ne chiffre rien. */
    create(input: { userId: number; workspaceId: number; content: string }): Promise<PasswordRow>;
    update(id: number, workspaceId: number, content: string): Promise<PasswordRow | null>;
    delete(id: number, workspaceId: number): Promise<boolean>;
}

export function createRepo(q: SdkQueryable): PasswordRepo {
    return {
        async listByWorkspace(workspaceId) {
            return q.query<PasswordRow>('SELECT * FROM passwords WHERE workspace_id = ? ORDER BY id ASC', [
                workspaceId
            ]);
        },
        async countByWorkspace(workspaceId) {
            const rows = await q.query<{ count: number }>(
                'SELECT COUNT(*) AS count FROM passwords WHERE workspace_id = ?',
                [workspaceId]
            );
            return Number(rows[0]?.count ?? 0);
        },
        async findById(id, workspaceId) {
            const rows = await q.query<PasswordRow>('SELECT * FROM passwords WHERE id = ? AND workspace_id = ?', [
                id,
                workspaceId
            ]);
            return rows[0] ?? null;
        },
        async create({ userId, workspaceId, content }) {
            const res = await q.execute(
                `INSERT INTO passwords (user_id, workspace_id, content)
                 VALUES (?, ?, ?)`,
                [userId, workspaceId, content]
            );
            const rows = await q.query<PasswordRow>('SELECT * FROM passwords WHERE id = ?', [res.insertId]);
            return rows[0];
        },
        async update(id, workspaceId, content) {
            const res = await q.execute('UPDATE passwords SET content = ? WHERE id = ? AND workspace_id = ?', [
                content,
                id,
                workspaceId
            ]);
            if (res.affectedRows === 0) return null;
            return this.findById(id, workspaceId);
        },
        async delete(id, workspaceId) {
            const res = await q.execute('DELETE FROM passwords WHERE id = ? AND workspace_id = ?', [id, workspaceId]);
            return res.affectedRows > 0;
        }
    };
}
