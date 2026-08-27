import type { NoteFolderRow, NoteRow } from '../contracts/domain';
import type { SdkQueryable } from '@deveye/types/sdk/server';

export interface CreateNoteInput {
    userId: number;
    workspaceId: number;
    folderId: number | null;
    content: string;
    isPrivate: boolean;
}

export interface UpdateNoteInput {
    folderId: number | null;
    content: string;
    isPrivate: boolean;
}

/**
 * Les deux tables des Notes derrière un seul dépôt, comme chez Météo et les
 * Finances : `notes` et `note_folders`, chacune avec ses verbes nommés (l'ex
 * `db.notes` et l'ex `db.noteFolders` de l'app, dont les deux interfaces
 * portaient les mêmes noms de méthodes).
 *
 * Les dossiers appartiennent à un **espace**. `user_id` ne subsiste que pour
 * dire qui a créé la ligne ; le cloisonnement est `workspace_id`.
 */
export interface NotesRepo {
    listNotes(workspaceId: number): Promise<NoteRow[]>;
    countActiveNotes(workspaceId: number): Promise<number>;
    findNote(id: number, workspaceId: number): Promise<NoteRow | null>;
    createNote(input: CreateNoteInput): Promise<NoteRow>;
    updateNote(id: number, workspaceId: number, input: UpdateNoteInput): Promise<NoteRow | null>;
    /**
     * File every listed note into `folderId` and rank it by its index. The caller
     * passes the folder's complete final content, so the ranks stay dense.
     */
    reorderNotes(workspaceId: number, folderId: number | null, noteIds: number[]): Promise<void>;
    /** Archive a note (`at` = epoch seconds); its rank is kept for the restore. */
    archiveNote(id: number, workspaceId: number, at: number): Promise<boolean>;
    /** Bring a note back into the active list, appended to the end of its folder. */
    restoreNote(id: number, workspaceId: number): Promise<boolean>;
    /** Destroy the row for good, reserved for already-archived notes. */
    deleteNote(id: number, workspaceId: number): Promise<boolean>;

    listFolders(workspaceId: number): Promise<NoteFolderRow[]>;
    findFolder(id: number, workspaceId: number): Promise<NoteFolderRow | null>;
    createFolder(input: { userId: number; workspaceId: number; content: string }): Promise<NoteFolderRow>;
    updateFolder(id: number, workspaceId: number, content: string): Promise<NoteFolderRow | null>;
    /** Assign `sort_order` to each id by its index in `ids`; returns the new list. */
    reorderFolders(workspaceId: number, ids: number[]): Promise<NoteFolderRow[]>;
    deleteFolder(id: number, workspaceId: number): Promise<boolean>;
}

/** Next free rank at the end of a folder (0 when it holds no active note). */
async function nextSortOrder(q: SdkQueryable, workspaceId: number, folderId: number | null): Promise<number> {
    const rows = await q.query<{ next: number }>(
        `SELECT COALESCE(MAX(sort_order) + 1, 0) AS next FROM notes
         WHERE workspace_id = ? AND archived_at IS NULL AND folder_id <=> ?`,
        [workspaceId, folderId]
    );
    return Number(rows[0]?.next ?? 0);
}

/** Mêmes dépôts qu'avant le rapatriement, portés sur le `SdkQueryable` du module. */
export function createRepo(q: SdkQueryable): NotesRepo {
    return {
        async listNotes(workspaceId) {
            // L'ordre choisi dans l'espace, par dossier ; l'id ne départage que les ex æquo.
            return q.query<NoteRow>('SELECT * FROM notes WHERE workspace_id = ? ORDER BY sort_order ASC, id ASC', [
                workspaceId
            ]);
        },
        async countActiveNotes(workspaceId) {
            const rows = await q.query<{ count: number }>(
                'SELECT COUNT(*) AS count FROM notes WHERE workspace_id = ? AND archived_at IS NULL',
                [workspaceId]
            );
            return Number(rows[0]?.count ?? 0);
        },
        async findNote(id, workspaceId) {
            const rows = await q.query<NoteRow>('SELECT * FROM notes WHERE id = ? AND workspace_id = ?', [
                id,
                workspaceId
            ]);
            return rows[0] ?? null;
        },
        async createNote({ userId, workspaceId, folderId, content, isPrivate }) {
            // New notes go to the end of their folder, where the "+" card sat.
            const sortOrder = await nextSortOrder(q, workspaceId, folderId);
            const res = await q.execute(
                `INSERT INTO notes (user_id, workspace_id, folder_id, content, sort_order, is_private)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [userId, workspaceId, folderId, content, sortOrder, isPrivate ? 1 : 0]
            );
            const rows = await q.query<NoteRow>('SELECT * FROM notes WHERE id = ?', [res.insertId]);
            return rows[0];
        },
        async updateNote(id, workspaceId, { folderId, content, isPrivate }) {
            const res = await q.execute(
                `UPDATE notes SET folder_id = ?, content = ?, is_private = ?, updated = UNIX_TIMESTAMP()
                 WHERE id = ? AND workspace_id = ?`,
                [folderId, content, isPrivate ? 1 : 0, id, workspaceId]
            );
            if (res.affectedRows === 0) return null;
            return this.findNote(id, workspaceId);
        },
        async reorderNotes(workspaceId, folderId, noteIds) {
            // Assign each id its rank by index; only rows of this workspace are
            // touched, so stray ids are silently ignored. `updated` stays put:
            // re-filing a note is not an edit of it.
            for (let i = 0; i < noteIds.length; i++) {
                await q.execute('UPDATE notes SET folder_id = ?, sort_order = ? WHERE id = ? AND workspace_id = ?', [
                    folderId,
                    i,
                    noteIds[i],
                    workspaceId
                ]);
            }
        },
        async archiveNote(id, workspaceId, at) {
            const res = await q.execute('UPDATE notes SET archived_at = ? WHERE id = ? AND workspace_id = ?', [
                at,
                id,
                workspaceId
            ]);
            return res.affectedRows > 0;
        },
        async restoreNote(id, workspaceId) {
            const existing = await this.findNote(id, workspaceId);
            if (!existing) return false;
            // Its old rank belonged to a list that has moved on; append instead.
            const sortOrder = await nextSortOrder(q, workspaceId, existing.folder_id);
            const res = await q.execute(
                'UPDATE notes SET archived_at = NULL, sort_order = ? WHERE id = ? AND workspace_id = ?',
                [sortOrder, id, workspaceId]
            );
            return res.affectedRows > 0;
        },
        async deleteNote(id, workspaceId) {
            const res = await q.execute('DELETE FROM notes WHERE id = ? AND workspace_id = ?', [id, workspaceId]);
            return res.affectedRows > 0;
        },

        async listFolders(workspaceId) {
            return q.query<NoteFolderRow>(
                'SELECT * FROM note_folders WHERE workspace_id = ? ORDER BY sort_order ASC, id ASC',
                [workspaceId]
            );
        },
        async findFolder(id, workspaceId) {
            const rows = await q.query<NoteFolderRow>('SELECT * FROM note_folders WHERE id = ? AND workspace_id = ?', [
                id,
                workspaceId
            ]);
            return rows[0] ?? null;
        },
        async createFolder({ userId, workspaceId, content }) {
            // New folders go to the end: next rank after the workspace's current max.
            const posRows = await q.query<{ next: number }>(
                'SELECT COALESCE(MAX(sort_order) + 1, 0) AS next FROM note_folders WHERE workspace_id = ?',
                [workspaceId]
            );
            const sortOrder = Number(posRows[0]?.next ?? 0);
            const res = await q.execute(
                'INSERT INTO note_folders (user_id, workspace_id, content, sort_order) VALUES (?, ?, ?, ?)',
                [userId, workspaceId, content, sortOrder]
            );
            const rows = await q.query<NoteFolderRow>('SELECT * FROM note_folders WHERE id = ?', [res.insertId]);
            return rows[0];
        },
        async updateFolder(id, workspaceId, content) {
            const res = await q.execute('UPDATE note_folders SET content = ? WHERE id = ? AND workspace_id = ?', [
                content,
                id,
                workspaceId
            ]);
            if (res.affectedRows === 0) return null;
            return this.findFolder(id, workspaceId);
        },
        async reorderFolders(workspaceId, ids) {
            // Assign each id its rank by index; only rows of this workspace are
            // touched, so stray ids are silently ignored.
            for (let i = 0; i < ids.length; i++) {
                await q.execute('UPDATE note_folders SET sort_order = ? WHERE id = ? AND workspace_id = ?', [
                    i,
                    ids[i],
                    workspaceId
                ]);
            }
            return this.listFolders(workspaceId);
        },
        async deleteFolder(id, workspaceId) {
            // Notes referencing this folder get folder_id → NULL via the FK's
            // ON DELETE SET NULL, so deleting a folder un-files its notes.
            const res = await q.execute('DELETE FROM note_folders WHERE id = ? AND workspace_id = ?', [
                id,
                workspaceId
            ]);
            return res.affectedRows > 0;
        }
    };
}
