import type { NoteFolderRow } from 'deveye-types';
import type { Queryable } from '../pool';

type Q = Queryable;

export interface NoteFoldersRepo {
    listByUser(userId: number): Promise<NoteFolderRow[]>;
    findById(id: number, userId: number): Promise<NoteFolderRow | null>;
    create(input: { userId: number; workspaceId: number | null; content: string }): Promise<NoteFolderRow>;
    update(id: number, userId: number, content: string): Promise<NoteFolderRow | null>;
    /** Assign `sort_order` to each id by its index in `ids`; returns the new list. */
    reorder(userId: number, ids: number[]): Promise<NoteFolderRow[]>;
    delete(id: number, userId: number): Promise<boolean>;
}

export function noteFoldersRepo(pool: Q): NoteFoldersRepo {
    return {
        async listByUser(userId) {
            const r = await pool.query<NoteFolderRow>(
                'SELECT * FROM note_folders WHERE user_id = ? ORDER BY sort_order ASC, id ASC',
                [userId]
            );
            return r.rows;
        },
        async findById(id, userId) {
            const r = await pool.query<NoteFolderRow>('SELECT * FROM note_folders WHERE id = ? AND user_id = ?', [
                id,
                userId
            ]);
            return r.rows[0] ?? null;
        },
        async create({ userId, workspaceId, content }) {
            // New folders go to the end: next rank after the user's current max.
            const posRow = await pool.query<{ next: number }>(
                'SELECT COALESCE(MAX(sort_order) + 1, 0) AS next FROM note_folders WHERE user_id = ?',
                [userId]
            );
            const sortOrder = Number(posRow.rows[0]?.next ?? 0);
            const res = await pool.query(
                'INSERT INTO note_folders (user_id, workspace_id, content, sort_order) VALUES (?, ?, ?, ?)',
                [userId, workspaceId, content, sortOrder]
            );
            const r = await pool.query<NoteFolderRow>('SELECT * FROM note_folders WHERE id = ?', [res.insertId]);
            return r.rows[0];
        },
        async update(id, userId, content) {
            const res = await pool.query('UPDATE note_folders SET content = ? WHERE id = ? AND user_id = ?', [
                content,
                id,
                userId
            ]);
            if (res.rowCount === 0) return null;
            const r = await pool.query<NoteFolderRow>('SELECT * FROM note_folders WHERE id = ? AND user_id = ?', [
                id,
                userId
            ]);
            return r.rows[0] ?? null;
        },
        async reorder(userId, ids) {
            // Assign each id its rank by index; only rows owned by the user are
            // touched, so stray ids are silently ignored.
            for (let i = 0; i < ids.length; i++) {
                await pool.query('UPDATE note_folders SET sort_order = ? WHERE id = ? AND user_id = ?', [
                    i,
                    ids[i],
                    userId
                ]);
            }
            return this.listByUser(userId);
        },
        async delete(id, userId) {
            // Notes referencing this folder get folder_id → NULL via the FK's
            // ON DELETE SET NULL, so deleting a folder un-files its notes.
            const r = await pool.query('DELETE FROM note_folders WHERE id = ? AND user_id = ?', [id, userId]);
            return r.rowCount > 0;
        }
    };
}
