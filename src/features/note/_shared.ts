import type { SecureStore } from '@/Services/SecureStore';
import type { Note, NoteBlock, NoteFolder, NoteFolderRow, NoteRow, NoteSummary } from 'deveye-types';
import { noteFolderSchema, noteSchema } from 'deveye-types';

/**
 * Stored payload (encrypted as `notes.content`). Holds only the sensitive parts
 * of a note; `folder_id`/`pinned`/`hidden`/`updated`/`id` live on the SQL row in
 * clear so the server can list, group and gate without decrypting the body.
 */
export interface StoredPayload {
    title: string;
    blocks: NoteBlock[];
}

export async function encryptPayload(secure: SecureStore, payload: StoredPayload): Promise<string> {
    return secure.encrypt(JSON.stringify(payload));
}

export async function tryDecryptPayload(secure: SecureStore, content: string): Promise<StoredPayload | null> {
    const plain = await secure.tryDecrypt(content);
    if (plain === null) return null;
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

/** Assemble the full client Note from a row + its decrypted payload. */
export function toNote(row: NoteRow, payload: StoredPayload): Note {
    return noteSchema.parse({
        id: row.id,
        title: payload.title,
        folderId: row.folder_id,
        blocks: payload.blocks,
        pinned: row.pinned === 1,
        hidden: row.hidden === 1,
        updated: row.updated
    });
}

const PREVIEW_MAX = 140;

/** First non-empty block's text, trimmed to a short single-line preview. */
function buildPreview(blocks: NoteBlock[]): string {
    for (const b of blocks) {
        const t = b.text.trim();
        if (t) return t.length > PREVIEW_MAX ? `${t.slice(0, PREVIEW_MAX)}…` : t;
    }
    return '';
}

/** Summary for a readable note (its body was successfully decrypted). */
export function toSummary(row: NoteRow, payload: StoredPayload): NoteSummary {
    const checks = payload.blocks.filter((b) => b.type === 'check');
    return {
        id: row.id,
        title: payload.title,
        folderId: row.folder_id,
        pinned: row.pinned === 1,
        hidden: row.hidden === 1,
        preview: buildPreview(payload.blocks),
        checkTotal: checks.length,
        checkDone: checks.filter((b) => b.type === 'check' && b.done).length,
        locked: false,
        updated: row.updated
    };
}

/**
 * Summary for a hidden note the session may not read yet: metadata only, no
 * body-derived fields, so nothing sensitive leaks before unlock. `folderId` is
 * a clear column (not sensitive on its own), so it's kept — the note still
 * groups under its folder while locked.
 */
export function toLockedSummary(row: NoteRow): NoteSummary {
    return {
        id: row.id,
        title: '',
        folderId: row.folder_id,
        pinned: row.pinned === 1,
        hidden: true,
        checkTotal: 0,
        checkDone: 0,
        locked: true,
        updated: row.updated
    };
}

/** Folder name payload (encrypted as `note_folders.content`). */
export interface FolderPayload {
    name: string;
}

export async function encryptFolder(secure: SecureStore, payload: FolderPayload): Promise<string> {
    return secure.encrypt(JSON.stringify(payload));
}

export async function tryDecryptFolder(secure: SecureStore, content: string): Promise<FolderPayload | null> {
    const plain = await secure.tryDecrypt(content);
    if (plain === null) return null;
    try {
        const parsed = JSON.parse(plain) as Partial<FolderPayload>;
        return { name: typeof parsed.name === 'string' ? parsed.name : '' };
    } catch {
        return null;
    }
}

export function toFolder(row: NoteFolderRow, payload: FolderPayload): NoteFolder {
    return noteFolderSchema.parse({ id: row.id, name: payload.name });
}

/**
 * Sessions that have passed "root auth" and may read hidden notes this
 * connection. Populated by `note.reveal`; never persisted and cleared on
 * disconnect. Kept separate from the SecureStore DEK cache: revealing hidden
 * notes is an authorization gate (account password), independent of whether
 * password-based encryption is enabled.
 */
const revealed = new Set<string>();

export function markRevealed(sessionId: string): void {
    revealed.add(sessionId);
}

export function isRevealed(sessionId: string): boolean {
    return revealed.has(sessionId);
}

export function forgetReveal(sessionId: string): void {
    revealed.delete(sessionId);
}
