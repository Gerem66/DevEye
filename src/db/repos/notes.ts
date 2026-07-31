import type { NoteRow } from 'deveye-types';
import type { Queryable } from '../pool';

type Q = Queryable;

export interface NotesRepo {
    listByUser(userId: number): Promise<NoteRow[]>;
    findById(id: number, userId: number): Promise<NoteRow | null>;
    create(input: {
        userId: number;
        workspaceId: number | null;
        folderId: number | null;
        content: string;
        isPrivate: boolean;
    }): Promise<NoteRow>;
    update(
        id: number,
        userId: number,
        input: { folderId: number | null; content: string; isPrivate: boolean }
    ): Promise<NoteRow | null>;
    /**
     * File every listed note into `folderId` and rank it by its index. The caller
     * passes the folder's complete final content, so the ranks stay dense.
     */
    reorder(userId: number, folderId: number | null, noteIds: number[]): Promise<void>;
    /** Archive a note (`at` = epoch seconds); its rank is kept for the restore. */
    archive(id: number, userId: number, at: number): Promise<boolean>;
    /** Bring a note back into the active list, appended to the end of its folder. */
    restore(id: number, userId: number): Promise<boolean>;
    /** Destroy the row for good — reserved for already-archived notes. */
    delete(id: number, userId: number): Promise<boolean>;
}

/** Next free rank at the end of a folder (0 when it holds no active note). */
async function nextSortOrder(pool: Q, userId: number, folderId: number | null): Promise<number> {
    const r = await pool.query<{ next: number }>(
        `SELECT COALESCE(MAX(sort_order) + 1, 0) AS next FROM notes
         WHERE user_id = ? AND archived_at IS NULL AND folder_id <=> ?`,
        [userId, folderId]
    );
    return Number(r.rows[0]?.next ?? 0);
}

export function notesRepo(pool: Q): NotesRepo {
    return {
        async listByUser(userId) {
            // The user's own order, per folder; id only breaks ties.
            const r = await pool.query<NoteRow>(
                'SELECT * FROM notes WHERE user_id = ? ORDER BY sort_order ASC, id ASC',
                [userId]
            );
            return r.rows;
        },
        async findById(id, userId) {
            const r = await pool.query<NoteRow>('SELECT * FROM notes WHERE id = ? AND user_id = ?', [id, userId]);
            return r.rows[0] ?? null;
        },
        async create({ userId, workspaceId, folderId, content, isPrivate }) {
            // New notes go to the end of their folder — where the "+" card sat.
            const sortOrder = await nextSortOrder(pool, userId, folderId);
            const res = await pool.query(
                `INSERT INTO notes (user_id, workspace_id, folder_id, content, sort_order, is_private)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [userId, workspaceId, folderId, content, sortOrder, isPrivate ? 1 : 0]
            );
            const r = await pool.query<NoteRow>('SELECT * FROM notes WHERE id = ?', [res.insertId]);
            return r.rows[0];
        },
        async update(id, userId, { folderId, content, isPrivate }) {
            const res = await pool.query(
                `UPDATE notes SET folder_id = ?, content = ?, is_private = ?, updated = UNIX_TIMESTAMP()
                 WHERE id = ? AND user_id = ?`,
                [folderId, content, isPrivate ? 1 : 0, id, userId]
            );
            if (res.rowCount === 0) return null;
            const r = await pool.query<NoteRow>('SELECT * FROM notes WHERE id = ? AND user_id = ?', [id, userId]);
            return r.rows[0] ?? null;
        },
        async reorder(userId, folderId, noteIds) {
            // Assign each id its rank by index; only rows owned by the user are
            // touched, so stray ids are silently ignored. `updated` stays put:
            // re-filing a note is not an edit of it.
            for (let i = 0; i < noteIds.length; i++) {
                await pool.query('UPDATE notes SET folder_id = ?, sort_order = ? WHERE id = ? AND user_id = ?', [
                    folderId,
                    i,
                    noteIds[i],
                    userId
                ]);
            }
        },
        async archive(id, userId, at) {
            const r = await pool.query('UPDATE notes SET archived_at = ? WHERE id = ? AND user_id = ?', [
                at,
                id,
                userId
            ]);
            return r.rowCount > 0;
        },
        async restore(id, userId) {
            const existing = await this.findById(id, userId);
            if (!existing) return false;
            // Its old rank belonged to a list that has moved on; append instead.
            const sortOrder = await nextSortOrder(pool, userId, existing.folder_id);
            const r = await pool.query(
                'UPDATE notes SET archived_at = NULL, sort_order = ? WHERE id = ? AND user_id = ?',
                [sortOrder, id, userId]
            );
            return r.rowCount > 0;
        },
        async delete(id, userId) {
            const r = await pool.query('DELETE FROM notes WHERE id = ? AND user_id = ?', [id, userId]);
            return r.rowCount > 0;
        }
    };
}
