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
        pinned: boolean;
        hidden: boolean;
    }): Promise<NoteRow>;
    update(
        id: number,
        userId: number,
        input: { folderId: number | null; content: string; pinned: boolean; hidden: boolean }
    ): Promise<NoteRow | null>;
    move(id: number, userId: number, folderId: number | null): Promise<NoteRow | null>;
    delete(id: number, userId: number): Promise<boolean>;
}

export function notesRepo(pool: Q): NotesRepo {
    return {
        async listByUser(userId) {
            // Pinned first, then most-recently updated — the order the UI renders.
            const r = await pool.query<NoteRow>(
                'SELECT * FROM notes WHERE user_id = ? ORDER BY pinned DESC, updated DESC, id DESC',
                [userId]
            );
            return r.rows;
        },
        async findById(id, userId) {
            const r = await pool.query<NoteRow>('SELECT * FROM notes WHERE id = ? AND user_id = ?', [id, userId]);
            return r.rows[0] ?? null;
        },
        async create({ userId, workspaceId, folderId, content, pinned, hidden }) {
            const res = await pool.query(
                `INSERT INTO notes (user_id, workspace_id, folder_id, content, pinned, hidden)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [userId, workspaceId, folderId, content, pinned ? 1 : 0, hidden ? 1 : 0]
            );
            const r = await pool.query<NoteRow>('SELECT * FROM notes WHERE id = ?', [res.insertId]);
            return r.rows[0];
        },
        async update(id, userId, { folderId, content, pinned, hidden }) {
            const res = await pool.query(
                `UPDATE notes SET folder_id = ?, content = ?, pinned = ?, hidden = ?, updated = UNIX_TIMESTAMP()
                 WHERE id = ? AND user_id = ?`,
                [folderId, content, pinned ? 1 : 0, hidden ? 1 : 0, id, userId]
            );
            if (res.rowCount === 0) return null;
            const r = await pool.query<NoteRow>('SELECT * FROM notes WHERE id = ? AND user_id = ?', [id, userId]);
            return r.rows[0] ?? null;
        },
        async move(id, userId, folderId) {
            const res = await pool.query(
                'UPDATE notes SET folder_id = ?, updated = UNIX_TIMESTAMP() WHERE id = ? AND user_id = ?',
                [folderId, id, userId]
            );
            if (res.rowCount === 0) return null;
            const r = await pool.query<NoteRow>('SELECT * FROM notes WHERE id = ? AND user_id = ?', [id, userId]);
            return r.rows[0] ?? null;
        },
        async delete(id, userId) {
            const r = await pool.query('DELETE FROM notes WHERE id = ? AND user_id = ?', [id, userId]);
            return r.rowCount > 0;
        }
    };
}
