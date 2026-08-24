import type { Cipher } from '@/Services/SecureStore';
import type { Note, NoteBlock, NoteFolder, NoteFolderRow, NoteRow, NoteSummary } from '@deveye/types';
import { noteFolderSchema, noteSchema } from '@deveye/types';

/**
 * Stored payload (encrypted as `notes.content`). Holds only the sensitive parts
 * of a note; `folder_id`/`sort_order`/`is_private`/`updated`/`id` live on the SQL
 * row in clear so the server can list, group and route without decrypting it.
 */
export interface StoredPayload {
    title: string;
    blocks: NoteBlock[];
}

export async function encryptPayload(cipher: Cipher, payload: StoredPayload): Promise<string> {
    return cipher.encrypt(JSON.stringify(payload));
}

function parsePayload(plain: string): StoredPayload | null {
    try {
        const parsed = JSON.parse(plain) as Partial<StoredPayload>;
        return {
            title: typeof parsed.title === 'string' ? parsed.title : '',
            blocks: Array.isArray(parsed.blocks) ? (parsed.blocks as NoteBlock[]) : []
        };
    } catch {
        return null;
    }
}

/**
 * Decrypt one note's body. Propagates the cipher's errors — notably `locked`
 * when a private note is read without a live DEK, which the client turns into
 * the unlock prompt.
 */
export async function decryptPayload(cipher: Cipher, content: string): Promise<StoredPayload | null> {
    return parsePayload(await cipher.decrypt(content));
}

/** Non-throwing variant for list paths, where one bad row must not fail all. */
export async function tryDecryptPayload(cipher: Cipher, content: string): Promise<StoredPayload | null> {
    const plain = await cipher.tryDecrypt(content);
    return plain === null ? null : parsePayload(plain);
}

/** Assemble the full client Note from a row + its decrypted payload. */
export function toNote(row: NoteRow, payload: StoredPayload): Note {
    return noteSchema.parse({
        id: row.id,
        title: payload.title,
        folderId: row.folder_id,
        blocks: payload.blocks,
        sortOrder: row.sort_order,
        private: row.is_private === 1,
        updated: row.updated,
        created: row.created
    });
}

const PREVIEW_MAX = 140;

/** First non-empty block's text, trimmed to a short single-line preview. */
function buildPreview(blocks: NoteBlock[]): string {
    for (const b of blocks) {
        const t = 'text' in b ? b.text.trim() : '';
        if (t) return t.length > PREVIEW_MAX ? `${t.slice(0, PREVIEW_MAX)}…` : t;
    }
    return '';
}

/** Summary for a note whose body was successfully decrypted. */
export function toSummary(row: NoteRow, payload: StoredPayload): NoteSummary {
    const checks = payload.blocks.filter((b) => b.type === 'check');
    return {
        id: row.id,
        title: payload.title,
        folderId: row.folder_id,
        sortOrder: row.sort_order,
        preview: buildPreview(payload.blocks),
        checkTotal: checks.length,
        checkDone: checks.filter((b) => b.type === 'check' && b.done).length,
        private: row.is_private === 1,
        masked: false,
        archivedAt: row.archived_at,
        updated: row.updated,
        created: row.created
    };
}

/**
 * Summary for a private note listed while the session is locked: clear metadata
 * only, no `title`/body-derived fields, so nothing sensitive leaks before the
 * password is entered. `folderId` is a clear column (not sensitive on its own),
 * so the note still groups under its folder while masked.
 */
export function toMaskedSummary(row: NoteRow): NoteSummary {
    return {
        id: row.id,
        title: '',
        folderId: row.folder_id,
        sortOrder: row.sort_order,
        checkTotal: 0,
        checkDone: 0,
        private: true,
        masked: true,
        archivedAt: row.archived_at,
        updated: row.updated,
        created: row.created
    };
}

/** Folder name payload (encrypted as `note_folders.content`, open tier). */
export interface FolderPayload {
    name: string;
}

export async function encryptFolder(cipher: Cipher, payload: FolderPayload): Promise<string> {
    return cipher.encrypt(JSON.stringify(payload));
}

/**
 * Decode a folder's name. Falls back to an empty name rather than dropping the
 * folder when the blob can't be read — a nameless bucket the user can rename is
 * better than notes silently losing their section.
 */
export async function decryptFolder(cipher: Cipher, content: string): Promise<FolderPayload> {
    const plain = await cipher.tryDecrypt(content);
    if (plain === null) return { name: '' };
    try {
        const parsed = JSON.parse(plain) as Partial<FolderPayload>;
        return { name: typeof parsed.name === 'string' ? parsed.name : '' };
    } catch {
        return { name: '' };
    }
}

export function toFolder(row: NoteFolderRow, payload: FolderPayload): NoteFolder {
    return noteFolderSchema.parse({ id: row.id, name: payload.name, sortOrder: row.sort_order });
}
