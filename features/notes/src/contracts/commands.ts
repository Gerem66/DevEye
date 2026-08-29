import { z } from 'zod';
import {
    NOTE_FOLDER_MAX_LENGTH,
    NOTE_MAX_BLOCKS,
    NOTE_TITLE_MAX_LENGTH,
    noteBlockSchema,
    noteFolderSchema,
    noteSchema,
    noteSummarySchema
} from './domain';

const folderId = z.number().int().positive();

/**
 * Commandes des notes et de leurs dossiers.
 *
 * L'espace visé n'apparaît dans aucune entrée : il voyage sur l'enveloppe WS
 * (voir `protocol/envelope`) et le dispatcheur le résout avant le handler.
 * Un seul préfixe, `notes.`, celui de l'id de la feature ; les dossiers
 * passent en verbes camelCase derrière lui (`notes.folderAdd`).
 */

/** The editable shape of a note: everything the client may set. */
const noteDraftSchema = z.object({
    title: z.string().max(NOTE_TITLE_MAX_LENGTH),
    folderId: folderId.nullable(),
    blocks: z.array(noteBlockSchema).max(NOTE_MAX_BLOCKS),
    /** Encrypt the body with the password-protected key rather than the open one. */
    private: z.boolean()
});

/**
 * Never gated: regular notes are decrypted with the open key, and private
 * notes come back **masked** (metadata only) while the session is locked.
 * `archived` swaps the two disjoint sets: the active notes (default) or the
 * archive, most recently archived first.
 */
export const notesList = {
    command: 'notes.list' as const,
    input: z.object({ archived: z.boolean().optional() }),
    output: z.object({ notes: z.array(noteSummarySchema) })
};

/**
 * Count the **active** notes. Clear metadata only (private notes included,
 * nothing decrypted), so the widget always shows a number even when locked.
 */
export const notesCount = {
    command: 'notes.count' as const,
    input: z.object({}),
    output: z.object({ count: z.number().int().nonnegative() })
};

/**
 * Fetch one note in full. A private note requires the session to be unlocked;
 * otherwise the server replies `locked` and the client opens the usual unlock
 * prompt before retrying.
 */
export const notesGet = {
    command: 'notes.get' as const,
    input: z.object({ noteId: z.number().int().positive() }),
    output: z.object({ note: noteSchema })
};

export const notesAdd = {
    command: 'notes.add' as const,
    input: z.object({ note: noteDraftSchema }),
    output: z.object({ note: noteSchema })
};

/**
 * Edit a note. Touching a note that is (or becomes) private requires the session
 * to be unlocked; the draft's `private` flag decides which key the new body is
 * written with, so flipping it re-encrypts the note into the other tier.
 */
export const notesEdit = {
    command: 'notes.edit' as const,
    input: z.object({
        noteId: z.number().int().positive(),
        note: noteDraftSchema
    }),
    output: z.object({ note: noteSchema })
};

/**
 * Archive a note: it leaves the main list but nothing is destroyed. This is what
 * "supprimer" does in the UI; {@link notesDelete} is the deliberate second step.
 */
export const notesArchive = {
    command: 'notes.archive' as const,
    input: z.object({ noteId: z.number().int().positive() }),
    output: z.object({ noteId: z.number().int().positive() })
};

/** Bring an archived note back into the active list. */
export const notesRestore = {
    command: 'notes.restore' as const,
    input: z.object({ noteId: z.number().int().positive() }),
    output: z.object({ noteId: z.number().int().positive() })
};

/**
 * Destroy a note for good. Only ever accepted on an **archived** note (`conflict`
 * otherwise), so nothing can be lost in one click. Like archiving, it requires
 * the session to be unlocked when the note is private.
 */
export const notesDelete = {
    command: 'notes.delete' as const,
    input: z.object({ noteId: z.number().int().positive() }),
    output: z.object({ noteId: z.number().int().positive() })
};

/**
 * Lay out one folder: `noteIds` is its **complete** content in its final order
 * (lower index first), and every listed note is filed into `folderId` on the
 * way, so one command covers both reordering and moving across folders.
 * Never touches the encrypted body, so it works on masked private notes too.
 */
export const notesReorder = {
    command: 'notes.reorder' as const,
    input: z.object({
        folderId: folderId.nullable(),
        noteIds: z.array(z.number().int().positive()).min(1)
    }),
    output: z.object({
        folderId: folderId.nullable(),
        noteIds: z.array(z.number().int().positive())
    })
};

/** List the active workspace's folders (names decrypted server-side). */
export const notesFolderList = {
    command: 'notes.folderList' as const,
    input: z.object({}),
    output: z.object({ folders: z.array(noteFolderSchema) })
};

export const notesFolderAdd = {
    command: 'notes.folderAdd' as const,
    input: z.object({ name: z.string().min(1).max(NOTE_FOLDER_MAX_LENGTH) }),
    output: z.object({ folder: noteFolderSchema })
};

export const notesFolderRename = {
    command: 'notes.folderRename' as const,
    input: z.object({ folderId, name: z.string().min(1).max(NOTE_FOLDER_MAX_LENGTH) }),
    output: z.object({ folder: noteFolderSchema })
};

/** `folderIds` is the new full order (lower index = listed first). */
export const notesFolderReorder = {
    command: 'notes.folderReorder' as const,
    input: z.object({ folderIds: z.array(folderId).min(1) }),
    output: z.object({ folders: z.array(noteFolderSchema) })
};

/** Delete a folder; its notes are un-filed (folderId → null), not destroyed. */
export const notesFolderDelete = {
    command: 'notes.folderDelete' as const,
    input: z.object({ folderId }),
    output: z.object({ folderId })
};

export const notesCommands = [
    notesList,
    notesCount,
    notesGet,
    notesAdd,
    notesEdit,
    notesArchive,
    notesRestore,
    notesDelete,
    notesReorder,
    notesFolderList,
    notesFolderAdd,
    notesFolderRename,
    notesFolderReorder,
    notesFolderDelete
] as const;
