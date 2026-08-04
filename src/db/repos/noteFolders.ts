import type { NoteFolderRow } from 'deveye-types';
import type { Queryable } from '../pool';

type Q = Queryable;

/**
 * Les dossiers appartiennent à un **espace**. `user_id` ne subsiste que pour
 * dire qui a créé la ligne ; le cloisonnement est `workspace_id`.
 */
export interface NoteFoldersRepo {
    listByWorkspace(workspaceId: number): Promise<NoteFolderRow[]>;
    findById(id: number, workspaceId: number): Promise<NoteFolderRow | null>;
    create(input: { userId: number; workspaceId: number; content: string }): Promise<NoteFolderRow>;
    update(id: number, workspaceId: number, content: string): Promise<NoteFolderRow | null>;
    /** Assign `sort_order` to each id by its index in `ids`; returns the new list. */
    reorder(workspaceId: number, ids: number[]): Promise<NoteFolderRow[]>;
    delete(id: number, workspaceId: number): Promise<boolean>;
}

export function noteFoldersRepo(pool: Q): NoteFoldersRepo {
    return {
        async listByWorkspace(workspaceId) {
            const r = await pool.query<NoteFolderRow>(
                'SELECT * FROM note_folders WHERE workspace_id = ? ORDER BY sort_order ASC, id ASC',
                [workspaceId]
            );
            return r.rows;
        },
        async findById(id, workspaceId) {
            const r = await pool.query<NoteFolderRow>('SELECT * FROM note_folders WHERE id = ? AND workspace_id = ?', [
                id,
                workspaceId
            ]);
            return r.rows[0] ?? null;
        },
        async create({ userId, workspaceId, content }) {
            // New folders go to the end: next rank after the workspace's current max.
            const posRow = await pool.query<{ next: number }>(
                'SELECT COALESCE(MAX(sort_order) + 1, 0) AS next FROM note_folders WHERE workspace_id = ?',
                [workspaceId]
            );
            const sortOrder = Number(posRow.rows[0]?.next ?? 0);
            const res = await pool.query(
                'INSERT INTO note_folders (user_id, workspace_id, content, sort_order) VALUES (?, ?, ?, ?)',
                [userId, workspaceId, content, sortOrder]
            );
            const r = await pool.query<NoteFolderRow>('SELECT * FROM note_folders WHERE id = ?', [res.insertId]);
            return r.rows[0];
        },
        async update(id, workspaceId, content) {
            const res = await pool.query('UPDATE note_folders SET content = ? WHERE id = ? AND workspace_id = ?', [
                content,
                id,
                workspaceId
            ]);
            if (res.rowCount === 0) return null;
            const r = await pool.query<NoteFolderRow>('SELECT * FROM note_folders WHERE id = ? AND workspace_id = ?', [
                id,
                workspaceId
            ]);
            return r.rows[0] ?? null;
        },
        async reorder(workspaceId, ids) {
            // Assign each id its rank by index; only rows of this workspace are
            // touched, so stray ids are silently ignored.
            for (let i = 0; i < ids.length; i++) {
                await pool.query('UPDATE note_folders SET sort_order = ? WHERE id = ? AND workspace_id = ?', [
                    i,
                    ids[i],
                    workspaceId
                ]);
            }
            return this.listByWorkspace(workspaceId);
        },
        async delete(id, workspaceId) {
            // Notes referencing this folder get folder_id → NULL via the FK's
            // ON DELETE SET NULL, so deleting a folder un-files its notes.
            const r = await pool.query('DELETE FROM note_folders WHERE id = ? AND workspace_id = ?', [id, workspaceId]);
            return r.rowCount > 0;
        }
    };
}
