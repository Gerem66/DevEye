import { hashPassword, verifyPassword } from '@/auth/argon';
import {
    folderAdd,
    folderDelete,
    folderList,
    folderRename,
    folderReorder,
    noteAdd,
    noteDelete,
    noteEdit,
    noteGet,
    noteList,
    noteMove
} from 'deveye-types';
import type { NoteRow } from 'deveye-types';
import { defineFeature, FeatureError, type FeatureContext, type FeatureDefinition } from '../_define';
import {
    encryptFolder,
    encryptPayload,
    toFolder,
    toLockedSummary,
    toNote,
    toSummary,
    tryDecryptFolder,
    tryDecryptPayload,
    type StoredPayload
} from './_shared';

/**
 * Workspace id 0 is the caller's private/personal workspace: no row, no
 * membership, items stored with `workspace_id = NULL`. Mirrors the passwords
 * feature so notes live alongside their workspace's other data.
 */
const PERSONAL_WORKSPACE_ID = 0;

async function assertWorkspaceMember(ctx: FeatureContext, workspaceId: number): Promise<void> {
    if (workspaceId === PERSONAL_WORKSPACE_ID) return;
    const ok = await ctx.db.workspaceMembers.isMember(ctx.userId, workspaceId);
    if (!ok) throw new FeatureError('forbidden', 'Not a member of this workspace');
}

function toDbWorkspaceId(workspaceId: number): number | null {
    return workspaceId === PERSONAL_WORKSPACE_ID ? null : workspaceId;
}

function rowInWorkspace(rowWorkspaceId: number | null, workspaceId: number): boolean {
    return (rowWorkspaceId ?? PERSONAL_WORKSPACE_ID) === workspaceId;
}

/**
 * Resolve and authorize a target folder. Returns the (validated) folder id, or
 * null when unfiled. Throws `not_found` if the folder isn't the caller's or is
 * in another workspace — a note can only live in a folder of its own workspace.
 */
async function resolveFolderId(
    ctx: FeatureContext,
    workspaceId: number,
    folderId: number | null
): Promise<number | null> {
    if (folderId === null) return null;
    const folder = await ctx.db.noteFolders.findById(folderId, ctx.userId);
    if (!folder || !rowInWorkspace(folder.workspace_id, workspaceId)) {
        throw new FeatureError('not_found', 'Folder not found');
    }
    return folderId;
}

/**
 * Verify a locked note's dedicated password against its stored hash. Open notes
 * (`lock_hash` null) never require one. Throws `auth_required` when a password is
 * needed but absent, `auth_invalid` when it doesn't match. The lock is purely an
 * access gate — checked on every operation that exposes or destroys the note.
 */
async function assertNoteUnlocked(row: NoteRow, password: string | undefined): Promise<void> {
    if (row.lock_hash === null) return;
    if (!password) throw new FeatureError('auth_required', 'Note verrouillée; saisissez son mot de passe');
    if (!(await verifyPassword(row.lock_hash, password))) {
        throw new FeatureError('auth_invalid', 'Mot de passe incorrect');
    }
}

/**
 * Resolve the new `lock_hash` for a save from the draft's optional `lock` change:
 *  - omitted        → keep the existing hash (content-only edit).
 *  - `{ set }`      → hash the new dedicated password (lock / re-lock).
 *  - `{ remove }`   → null (unlock the note).
 */
async function resolveLockHash(
    lock: { set: string } | { remove: true } | undefined,
    existing: string | null
): Promise<string | null> {
    if (!lock) return existing;
    if ('remove' in lock) return null;
    return hashPassword(lock.set);
}

/** Normalize a draft into the encrypted payload (folder lives in a clear column). */
function toPayload(draft: { title: string; blocks: StoredPayload['blocks'] }): StoredPayload {
    return { title: draft.title, blocks: draft.blocks };
}

/**
 * Ensure the password-based encryption DEK is available this session. No-op when
 * the feature is off; throws `locked` (the client prompts for the password) when
 * it's on but the session hasn't been unlocked yet. Mirrors the Password feature
 * so a locked store surfaces an unlock prompt instead of an empty list.
 */
async function assertSecureUnlocked(ctx: FeatureContext): Promise<void> {
    try {
        if (!(await ctx.secure.isUnlocked())) {
            throw new FeatureError('locked', 'Password encryption is locked; unlock with your password');
        }
    } catch (e) {
        if (e instanceof FeatureError) throw e;
        ctx.logger.warn({ err: e }, 'assertSecureUnlocked: failed to check lock state, assuming unlocked');
    }
}

export const noteListFeature: FeatureDefinition<
    typeof noteList.command,
    typeof noteList.input,
    typeof noteList.output
> = defineFeature({
    ...noteList,
    handler: async (ctx, input) => {
        await assertWorkspaceMember(ctx, input.workspaceId);
        await assertSecureUnlocked(ctx);
        const rows = (await ctx.db.notes.listByUser(ctx.userId)).filter((r) =>
            rowInWorkspace(r.workspace_id, input.workspaceId)
        );

        let skipped = 0;
        const notes = (
            await Promise.all(
                rows.map(async (r) => {
                    // Locked notes are always masked in the list: title + body stay
                    // hidden until the per-note password is entered on open.
                    if (r.lock_hash !== null) return toLockedSummary(r);
                    const payload = await tryDecryptPayload(ctx.secure, r.content);
                    if (!payload) {
                        // A locked SecureStore (password encryption on, session not
                        // unlocked) surfaces here as an undecryptable body — drop it.
                        skipped += 1;
                        return null;
                    }
                    return toSummary(r, payload);
                })
            )
        ).filter((n): n is NonNullable<typeof n> => n !== null);

        if (skipped > 0) {
            ctx.logger.warn({ skipped, total: rows.length }, 'note.list: skipped undecryptable rows');
        }
        return { notes };
    }
});

export const noteGetFeature: FeatureDefinition<typeof noteGet.command, typeof noteGet.input, typeof noteGet.output> =
    defineFeature({
        ...noteGet,
        handler: async (ctx, input) => {
            await assertWorkspaceMember(ctx, input.workspaceId);
            await assertSecureUnlocked(ctx);
            const row = await ctx.db.notes.findById(input.noteId, ctx.userId);
            if (!row || !rowInWorkspace(row.workspace_id, input.workspaceId)) {
                throw new FeatureError('not_found', 'Note not found');
            }
            await assertNoteUnlocked(row, input.password);
            const payload = await tryDecryptPayload(ctx.secure, row.content);
            if (!payload) throw new FeatureError('internal', 'Failed to decrypt note content');
            return { note: toNote(row, payload) };
        }
    });

export const noteAddFeature: FeatureDefinition<typeof noteAdd.command, typeof noteAdd.input, typeof noteAdd.output> =
    defineFeature({
        ...noteAdd,
        handler: async (ctx, input) => {
            await assertWorkspaceMember(ctx, input.workspaceId);
            await assertSecureUnlocked(ctx);
            const folderId = await resolveFolderId(ctx, input.workspaceId, input.note.folderId);
            const content = await encryptPayload(ctx.secure, toPayload(input.note));
            const lockHash = await resolveLockHash(input.note.lock, null);
            const row = await ctx.db.notes.create({
                userId: ctx.userId,
                workspaceId: toDbWorkspaceId(input.workspaceId),
                folderId,
                content,
                pinned: input.note.pinned,
                lockHash
            });
            return { note: toNote(row, toPayload(input.note)) };
        }
    });

export const noteEditFeature: FeatureDefinition<
    typeof noteEdit.command,
    typeof noteEdit.input,
    typeof noteEdit.output
> = defineFeature({
    ...noteEdit,
    handler: async (ctx, input) => {
        await assertWorkspaceMember(ctx, input.workspaceId);
        await assertSecureUnlocked(ctx);
        const existing = await ctx.db.notes.findById(input.noteId, ctx.userId);
        if (!existing || !rowInWorkspace(existing.workspace_id, input.workspaceId)) {
            throw new FeatureError('not_found', 'Note not found');
        }
        // Editing a locked note's content requires its existing password (proof
        // the note was legitimately opened before saving over it).
        await assertNoteUnlocked(existing, input.password);
        const folderId = await resolveFolderId(ctx, input.workspaceId, input.note.folderId);
        const content = await encryptPayload(ctx.secure, toPayload(input.note));
        const lockHash = await resolveLockHash(input.note.lock, existing.lock_hash);
        const updated = await ctx.db.notes.update(input.noteId, ctx.userId, {
            folderId,
            content,
            pinned: input.note.pinned,
            lockHash
        });
        if (!updated) throw new FeatureError('not_found', 'Note not found');
        return { note: toNote(updated, toPayload(input.note)) };
    }
});

export const noteMoveFeature: FeatureDefinition<
    typeof noteMove.command,
    typeof noteMove.input,
    typeof noteMove.output
> = defineFeature({
    ...noteMove,
    handler: async (ctx, input) => {
        await assertWorkspaceMember(ctx, input.workspaceId);
        const existing = await ctx.db.notes.findById(input.noteId, ctx.userId);
        if (!existing || !rowInWorkspace(existing.workspace_id, input.workspaceId)) {
            throw new FeatureError('not_found', 'Note not found');
        }
        // Moving is a benign reorganization that never exposes the body, so it is
        // not gated by the lock — even a locked note can be re-filed freely.
        const folderId = await resolveFolderId(ctx, input.workspaceId, input.folderId);
        const updated = await ctx.db.notes.move(input.noteId, ctx.userId, folderId);
        if (!updated) throw new FeatureError('not_found', 'Note not found');
        return { noteId: input.noteId, folderId };
    }
});

export const noteDeleteFeature: FeatureDefinition<
    typeof noteDelete.command,
    typeof noteDelete.input,
    typeof noteDelete.output
> = defineFeature({
    ...noteDelete,
    handler: async (ctx, input) => {
        await assertWorkspaceMember(ctx, input.workspaceId);
        const existing = await ctx.db.notes.findById(input.noteId, ctx.userId);
        if (!existing || !rowInWorkspace(existing.workspace_id, input.workspaceId)) {
            throw new FeatureError('not_found', 'Note not found');
        }
        // Deleting is destructive, so a locked note requires its password — one
        // can't destroy a note it couldn't open. Moving (above) stays free.
        await assertNoteUnlocked(existing, input.password);
        await ctx.db.notes.delete(input.noteId, ctx.userId);
        return { noteId: input.noteId };
    }
});

export const folderListFeature: FeatureDefinition<
    typeof folderList.command,
    typeof folderList.input,
    typeof folderList.output
> = defineFeature({
    ...folderList,
    handler: async (ctx, input) => {
        await assertWorkspaceMember(ctx, input.workspaceId);
        await assertSecureUnlocked(ctx);
        const rows = (await ctx.db.noteFolders.listByUser(ctx.userId)).filter((r) =>
            rowInWorkspace(r.workspace_id, input.workspaceId)
        );
        const folders = (
            await Promise.all(
                rows.map(async (r) => {
                    const payload = await tryDecryptFolder(ctx.secure, r.content);
                    return payload ? toFolder(r, payload) : null;
                })
            )
        ).filter((f): f is NonNullable<typeof f> => f !== null);
        return { folders };
    }
});

export const folderAddFeature: FeatureDefinition<
    typeof folderAdd.command,
    typeof folderAdd.input,
    typeof folderAdd.output
> = defineFeature({
    ...folderAdd,
    handler: async (ctx, input) => {
        await assertWorkspaceMember(ctx, input.workspaceId);
        await assertSecureUnlocked(ctx);
        const name = input.name.trim();
        const content = await encryptFolder(ctx.secure, { name });
        const row = await ctx.db.noteFolders.create({
            userId: ctx.userId,
            workspaceId: toDbWorkspaceId(input.workspaceId),
            content
        });
        return { folder: toFolder(row, { name }) };
    }
});

export const folderRenameFeature: FeatureDefinition<
    typeof folderRename.command,
    typeof folderRename.input,
    typeof folderRename.output
> = defineFeature({
    ...folderRename,
    handler: async (ctx, input) => {
        await assertWorkspaceMember(ctx, input.workspaceId);
        await assertSecureUnlocked(ctx);
        const existing = await ctx.db.noteFolders.findById(input.folderId, ctx.userId);
        if (!existing || !rowInWorkspace(existing.workspace_id, input.workspaceId)) {
            throw new FeatureError('not_found', 'Folder not found');
        }
        const name = input.name.trim();
        const content = await encryptFolder(ctx.secure, { name });
        const updated = await ctx.db.noteFolders.update(input.folderId, ctx.userId, content);
        if (!updated) throw new FeatureError('not_found', 'Folder not found');
        return { folder: toFolder(updated, { name }) };
    }
});

export const folderReorderFeature: FeatureDefinition<
    typeof folderReorder.command,
    typeof folderReorder.input,
    typeof folderReorder.output
> = defineFeature({
    ...folderReorder,
    handler: async (ctx, input) => {
        await assertWorkspaceMember(ctx, input.workspaceId);
        await assertSecureUnlocked(ctx);
        // Reorder only the rows that are the caller's and in this workspace; any
        // foreign or out-of-workspace id in `folderIds` is dropped silently.
        const owned = (await ctx.db.noteFolders.listByUser(ctx.userId)).filter((r) =>
            rowInWorkspace(r.workspace_id, input.workspaceId)
        );
        const ownedIds = new Set(owned.map((r) => r.id));
        const orderedIds = input.folderIds.filter((id) => ownedIds.has(id));
        const rows = (await ctx.db.noteFolders.reorder(ctx.userId, orderedIds)).filter((r) =>
            rowInWorkspace(r.workspace_id, input.workspaceId)
        );
        const folders = (
            await Promise.all(
                rows.map(async (r) => {
                    const payload = await tryDecryptFolder(ctx.secure, r.content);
                    return payload ? toFolder(r, payload) : null;
                })
            )
        ).filter((f): f is NonNullable<typeof f> => f !== null);
        return { folders };
    }
});

export const folderDeleteFeature: FeatureDefinition<
    typeof folderDelete.command,
    typeof folderDelete.input,
    typeof folderDelete.output
> = defineFeature({
    ...folderDelete,
    handler: async (ctx, input) => {
        await assertWorkspaceMember(ctx, input.workspaceId);
        const existing = await ctx.db.noteFolders.findById(input.folderId, ctx.userId);
        if (!existing || !rowInWorkspace(existing.workspace_id, input.workspaceId)) {
            throw new FeatureError('not_found', 'Folder not found');
        }
        await ctx.db.noteFolders.delete(input.folderId, ctx.userId);
        return { folderId: input.folderId };
    }
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const noteFeatures: FeatureDefinition<string, any, any>[] = [
    noteListFeature,
    noteGetFeature,
    noteAddFeature,
    noteEditFeature,
    noteMoveFeature,
    noteDeleteFeature,
    folderListFeature,
    folderAddFeature,
    folderRenameFeature,
    folderReorderFeature,
    folderDeleteFeature
];
