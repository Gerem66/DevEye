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

/** Le contexte d'une commande des Notes : le contexte du SDK, sur le dépôt du module. */
export type Ctx = SdkFeatureContext<NotesRepo>;

/**
 * Depuis le rapatriement, la lecture est implicite (le défaut du SDK) : seules
 * les écritures déclarent leur niveau.
 */
export const WRITE = { level: 'write' } as const;

/**
 * The tier a NEW note's body lives in: private notes use the password-protected
 * DEK, everything else the open one. Picking the cipher IS the access control:
 * a private note simply can't be read or written while the session is locked.
 *
 * `ctx.cipher('private')` est l'ex `ctx.secure` (l'étage gardé),
 * `ctx.cipher()` l'ex `ctx.secure.open` (l'étage ouvert, celui des dossiers
 * et des notes ordinaires). Pour une note **existante**, voir {@link bodyCipher} :
 * l'étage ouvert est celui de son domicile, pas forcément celui d'ici.
 */
export function cipherFor(ctx: Ctx, isPrivate: boolean): SdkCipher {
    return isPrivate ? ctx.cipher('private') : ctx.cipher();
}

/**
 * Le codec du corps d'une note existante, **choisi ligne à ligne**.
 *
 * Une note privée est toujours chez elle (elle ne se projette pas, et sa
 * bascule oublie ses projections) : son corps passe par l'étage gardé d'ici.
 * Une note ordinaire peut être projetée
 * depuis un autre espace : elle reste chiffrée sous la clé ouverte de cet
 * espace-là, et `scope.cipherFor` la rend (celle d'ici quand la note est
 * locale). La déchiffrer avec la clé d'ici rendrait une ligne illisible, que
 * la liste prendrait pour une ligne corrompue.
 */
export function bodyCipher(ctx: Ctx, scope: SdkShareScope, row: NoteRow): Promise<SdkCipher> {
    return row.is_private === 1 ? Promise.resolve(ctx.cipher('private')) : scope.cipherFor(row.id);
}

/** Vrai quand la note vient d'un autre espace, qui la projette ici. */
export function isForeign(ctx: Ctx, row: NoteRow): boolean {
    return row.workspace_id !== ctx.workspaceId;
}

/**
 * Resolve and authorize a target folder. Returns the (validated) folder id, or
 * null when unfiled. Throws `not_found` if the folder is in another workspace:
 * a note can only live in a folder of its own workspace.
 */
export async function resolveFolderId(ctx: Ctx, folderId: number | null): Promise<number | null> {
    if (folderId === null) return null;
    const folder = await ctx.repo.findFolder(folderId, ctx.workspaceId);
    if (!folder) throw new FeatureError('not_found', 'Folder not found');
    return folderId;
}

/**
 * Une note visible depuis cet espace : la sienne, ou une qu'un autre espace y
 * projette. Lève `not_found` sinon.
 *
 * `level` décide de la garde : `ctx.items.assert` refuse en plus les notes
 * qu'une restriction de rôle masque ou passe en lecture seule. La feature
 * seule ne suffit plus à répondre « cette note-là m'est-elle ouverte ? ».
 */
export async function loadNote(ctx: Ctx, noteId: number, level: 'read' | 'write' = 'read'): Promise<NoteRow> {
    const row = await ctx.repo.findVisible(noteId, ctx.workspaceId);
    if (!row) throw new FeatureError('not_found', 'Note not found');
    await ctx.items.assert(noteId, level);
    return row;
}

/**
 * Le drapeau « privée » n'a de sens que dans un espace personnel.
 *
 * Ce qui protège une note privée n'est pas un contrôle d'accès mais le
 * chiffrement lui-même : son corps passe par l'étage gardé, c'est-à-dire la DEK
 * emballée par le mot de passe. Or dans un espace partagé les deux étages
 * utilisent la clé de l'espace, lisible par tout membre : accepter le drapeau y
 * produirait une note « privée » que tous peuvent lire, trompeuse pour celui
 * qui la crée en croyant la garder pour lui.
 *
 * Refus explicite plutôt que retombée silencieuse sur « publique » : demander
 * une note privée et en obtenir une lisible par tous serait le pire des deux.
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
 * Guard the destructive/rewriting paths on an existing private note. Encryption
 * alone protects reads, but an edit or a delete never needs to *read* the body;
 * without this, a locked session could overwrite or destroy a note it can't see.
 * Throws `locked`, which the client turns into the usual unlock prompt.
 *
 * `ctx.secrecy.isUnlocked()` est l'ex `ctx.secure.isUnlocked()` : la même
 * question, posée au verrou du SDK.
 */
export async function assertPrivateUnlocked(ctx: Ctx, row: NoteRow): Promise<void> {
    if (row.is_private !== 1) return;
    if (!(await ctx.secrecy.isUnlocked())) {
        throw new FeatureError('locked', 'Password encryption is locked; unlock with your password');
    }
}

/**
 * Stored payload (encrypted as `notes.content`). Holds only the sensitive parts
 * of a note; `folder_id`/`sort_order`/`is_private`/`updated`/`id` live on the SQL
 * row in clear so the server can list, group and route without decrypting it.
 */
export interface StoredPayload {
    title: string;
    blocks: NoteBlock[];
}

/** Normalize a draft into the encrypted payload (the rest lives in clear columns). */
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

/**
 * Decrypt one note's body. Propagates the cipher's errors, notably `locked`
 * when a private note is read without a live DEK, which the client turns into
 * the unlock prompt.
 */
export async function decryptPayload(cipher: SdkCipher, content: string): Promise<StoredPayload | null> {
    return parsePayload(await cipher.decrypt(content));
}

/** Non-throwing variant for list paths, where one bad row must not fail all. */
export async function tryDecryptPayload(cipher: SdkCipher, content: string): Promise<StoredPayload | null> {
    const plain = await cipher.tryDecrypt(content);
    return plain === null ? null : parsePayload(plain);
}

/**
 * Assemble the full client Note from a row + its decrypted payload.
 *
 * `foreign` neutralise le dossier : il désigne un dossier de l'espace
 * d'origine, que cet espace ne connaît pas, et l'annoncer ici ferait chercher
 * la note dans une section qui n'existe pas.
 */
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

/** First non-empty block's text, trimmed to a short single-line preview. */
function buildPreview(blocks: NoteBlock[]): string {
    for (const b of blocks) {
        const t = 'text' in b ? b.text.trim() : '';
        if (t) return t.length > PREVIEW_MAX ? `${t.slice(0, PREVIEW_MAX)}…` : t;
    }
    return '';
}

/** Summary for a note whose body was successfully decrypted. */
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
 * Summary for a private note listed while the session is locked: clear metadata
 * only, no `title`/body-derived fields, so nothing sensitive leaks before the
 * password is entered. `folderId` is a clear column (not sensitive on its own),
 * so the note still groups under its folder while masked. Jamais projetée :
 * une note privée n'est visible que chez elle.
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
 * Decode a folder's name. Falls back to an empty name rather than dropping the
 * folder when the blob can't be read: a nameless bucket the user can rename is
 * better than notes silently losing their section.
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
