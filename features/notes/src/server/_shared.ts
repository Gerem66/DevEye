import {
    noteFolderSchema,
    noteSchema,
    type Note,
    type NoteBlock,
    type NoteFolder,
    type NoteFolderRow,
    type NoteRow,
    type NoteSummary
} from '../contracts/domain';
import { FeatureError, type SdkCipher, type SdkFeatureContext, type SdkShareScope } from '@deveye/types/sdk/server';

import type { NotesRepo } from './repo';

export type Ctx = SdkFeatureContext<NotesRepo>;

/** La lecture est le défaut du SDK : seules les écritures déclarent leur niveau. */
export const WRITE = { level: 'write' } as const;

/**
 * The tier a NEW note's body lives in. Picking the cipher IS the access
 * control: a private note simply can't be read or written while the session
 * is locked. For an existing note see {@link bodyCipher}: its open tier is
 * its home's, not necessarily this workspace's.
 */
export function cipherFor(ctx: Ctx, isPrivate: boolean): SdkCipher {
    return isPrivate ? ctx.cipher('private') : ctx.cipher();
}

/**
 * Le codec du corps d'une note existante, choisi ligne à ligne. Une note
 * privée est toujours chez elle : l'étage gardé d'ici. Une note ordinaire peut
 * être projetée depuis un autre espace : elle reste chiffrée sous la clé
 * ouverte de cet espace-là, que `scope.cipherFor` rend ; la déchiffrer avec la
 * clé d'ici donnerait une ligne illisible, prise pour corrompue.
 */
export function bodyCipher(ctx: Ctx, scope: SdkShareScope, row: NoteRow): Promise<SdkCipher> {
    return row.is_private === 1 ? Promise.resolve(ctx.cipher('private')) : scope.cipherFor(row.id);
}

/** Vrai quand la note vient d'un autre espace, qui la projette ici. */
export function isForeign(ctx: Ctx, row: NoteRow): boolean {
    return row.workspace_id !== ctx.workspaceId;
}

/** Throws `not_found` for a folder of another workspace: a note only lives in a folder of its own. */
export async function resolveFolderId(ctx: Ctx, folderId: number | null): Promise<number | null> {
    if (folderId === null) return null;
    const folder = await ctx.repo.findFolder(folderId, ctx.workspaceId);
    if (!folder) throw new FeatureError('not_found', 'Folder not found');
    return folderId;
}

/**
 * Une note visible depuis cet espace : la sienne, ou une projetée ici.
 * `ctx.items.assert` refuse en plus celles qu'une restriction de rôle masque
 * ou passe en lecture seule.
 */
export async function loadNote(ctx: Ctx, noteId: number, level: 'read' | 'write' = 'read'): Promise<NoteRow> {
    const row = await ctx.repo.findVisible(noteId, ctx.workspaceId);
    if (!row) throw new FeatureError('not_found', 'Note not found');
    await ctx.items.assert(noteId, level);
    return row;
}

/**
 * Dans un espace partagé les deux étages utilisent la clé de l'espace, lisible
 * par tout membre : une note « privée » y serait lisible par tous, trompeuse
 * pour son auteur. Refus explicite plutôt que retombée silencieuse sur
 * « publique ».
 */
export function assertPrivateAllowed(ctx: Ctx, isPrivate: boolean): void {
    if (!isPrivate || ctx.workspace.kind === 'personal') return;
    throw new FeatureError(
        'validation',
        'Une note privée n’existe que dans votre espace personnel : dans un espace partagé, ' +
            'elle serait lisible par tous les membres.'
    );
}

/**
 * Encryption alone protects reads, but an edit or a delete never needs to read
 * the body: without this, a locked session could overwrite or destroy a
 * private note it can't see. Throws `locked`.
 */
export async function assertPrivateUnlocked(ctx: Ctx, row: NoteRow): Promise<void> {
    if (row.is_private !== 1) return;
    if (!(await ctx.secrecy.isUnlocked())) {
        throw new FeatureError('locked', 'Password encryption is locked; unlock with your password');
    }
}

/**
 * Encrypted as `notes.content`: only the sensitive parts. Folder, rank, flag
 * and dates live on the row in clear so the server can list, group and route
 * without decrypting.
 */
export interface StoredPayload {
    title: string;
    blocks: NoteBlock[];
}

export function toPayload(draft: { title: string; blocks: NoteBlock[] }): StoredPayload {
    return { title: draft.title, blocks: draft.blocks };
}

export async function encryptPayload(cipher: SdkCipher, payload: StoredPayload): Promise<string> {
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

/** Propagates the cipher's errors, notably `locked` on a private note without a live DEK. */
export async function decryptPayload(cipher: SdkCipher, content: string): Promise<StoredPayload | null> {
    return parsePayload(await cipher.decrypt(content));
}

/** Non-throwing variant for list paths, where one bad row must not fail all. */
export async function tryDecryptPayload(cipher: SdkCipher, content: string): Promise<StoredPayload | null> {
    const plain = await cipher.tryDecrypt(content);
    return plain === null ? null : parsePayload(plain);
}

/** `foreign` neutralise le dossier : il désigne un dossier de l'espace d'origine, inconnu ici. */
export function toNote(row: NoteRow, payload: StoredPayload, foreign: boolean): Note {
    return noteSchema.parse({
        id: row.id,
        title: payload.title,
        folderId: foreign ? null : row.folder_id,
        blocks: payload.blocks,
        sortOrder: row.sort_order,
        private: row.is_private === 1,
        foreign,
        updated: row.updated,
        created: row.created
    });
}

const PREVIEW_MAX = 140;

function buildPreview(blocks: NoteBlock[]): string {
    for (const b of blocks) {
        const t = 'text' in b ? b.text.trim() : '';
        if (t) return t.length > PREVIEW_MAX ? `${t.slice(0, PREVIEW_MAX)}…` : t;
    }
    return '';
}

export function toSummary(row: NoteRow, payload: StoredPayload, foreign: boolean): NoteSummary {
    const checks = payload.blocks.filter((b) => b.type === 'check');
    return {
        id: row.id,
        title: payload.title,
        folderId: foreign ? null : row.folder_id,
        sortOrder: row.sort_order,
        preview: buildPreview(payload.blocks),
        checkTotal: checks.length,
        checkDone: checks.filter((b) => b.type === 'check' && b.done).length,
        private: row.is_private === 1,
        masked: false,
        foreign,
        archivedAt: row.archived_at,
        updated: row.updated,
        created: row.created
    };
}

/**
 * A private note listed while locked: clear metadata only, nothing derived
 * from the body. `folderId` is a clear column, so the note still groups under
 * its folder. Jamais projetée : une note privée n'est visible que chez elle.
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
        foreign: false,
        archivedAt: row.archived_at,
        updated: row.updated,
        created: row.created
    };
}

/** Folder name payload (encrypted as `note_folders.content`, open tier). */
export interface FolderPayload {
    name: string;
}

export async function encryptFolder(cipher: SdkCipher, payload: FolderPayload): Promise<string> {
    return cipher.encrypt(JSON.stringify(payload));
}

/**
 * An unreadable blob yields an empty name rather than dropping the folder:
 * a nameless bucket the user can rename beats notes silently losing their section.
 */
export async function decryptFolder(cipher: SdkCipher, content: string): Promise<FolderPayload> {
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
