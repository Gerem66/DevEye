import { verifyPassword } from '@/auth/argon';
import {
    folderAdd,
    folderDelete,
    folderList,
    folderRename,
    noteAdd,
    noteDelete,
    noteEdit,
    noteGet,
    noteList,
    noteMove,
    noteReveal
} from 'deveye-types';
import { defineFeature, FeatureError, type FeatureContext, type FeatureDefinition } from '../_define';
import {
    encryptFolder,
    encryptPayload,
    isRevealed,
    markRevealed,
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
 * Whether this session may read hidden notes ("root auth"). True when either:
 *  - the session passed `note.reveal` (account-password check), or
 *  - password-based encryption is on AND the DEK is live (the cached master
 *    password is itself the proof the user asked for).
 *
 * The passive check never slides the grace window — gating must not count as
 * encrypted-data activity.
 */
async function canRevealHidden(ctx: FeatureContext): Promise<boolean> {
    if (isRevealed(ctx.sessionId)) return true;
    try {
        const row = await ctx.secretKeys.ensureRow(ctx.userId);
        if (ctx.secretKeys.isPasswordWrapped(row)) {
            return await ctx.secure.isUnlockedPassive();
        }
    } catch (e) {
        ctx.logger.warn({ err: e }, 'note.canRevealHidden: secret-key check failed; treating as not revealed');
    }
    return false;
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
        const allowHidden = await canRevealHidden(ctx);
        const rows = (await ctx.db.notes.listByUser(ctx.userId)).filter((r) =>
            rowInWorkspace(r.workspace_id, input.workspaceId)
        );

        let skipped = 0;
        const notes = (
            await Promise.all(
                rows.map(async (r) => {
                    // Hidden + not authorized → masked summary, body never decrypted.
                    if (r.hidden === 1 && !allowHidden) return toLockedSummary(r);
                    const payload = await tryDecryptPayload(ctx.secure, r.content);
                    if (!payload) {
                        // A locked SecureStore (password encryption on, session not
                        // unlocked) surfaces here as an undecryptable body. Mask it
                        // rather than dropping the row so the note stays listed.
                        if (r.hidden === 1) return toLockedSummary(r);
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
            if (row.hidden === 1 && !(await canRevealHidden(ctx))) {
                throw new FeatureError('auth_required', 'Hidden note locked; reveal with your password');
            }
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
            // Creating a hidden note requires the same authorization as reading one,
            // so a locked session can't quietly stash content it then can't reopen.
            if (input.note.hidden && !(await canRevealHidden(ctx))) {
                throw new FeatureError('auth_required', 'Reveal hidden notes before creating one');
            }
            const folderId = await resolveFolderId(ctx, input.workspaceId, input.note.folderId);
            const content = await encryptPayload(ctx.secure, toPayload(input.note));
            const row = await ctx.db.notes.create({
                userId: ctx.userId,
                workspaceId: toDbWorkspaceId(input.workspaceId),
                folderId,
                content,
                pinned: input.note.pinned,
                hidden: input.note.hidden
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
        // Touching a note that is (or becomes) hidden requires authorization.
        if ((existing.hidden === 1 || input.note.hidden) && !(await canRevealHidden(ctx))) {
            throw new FeatureError('auth_required', 'Reveal hidden notes before editing');
        }
        const folderId = await resolveFolderId(ctx, input.workspaceId, input.note.folderId);
        const content = await encryptPayload(ctx.secure, toPayload(input.note));
        const updated = await ctx.db.notes.update(input.noteId, ctx.userId, {
            folderId,
            content,
            pinned: input.note.pinned,
            hidden: input.note.hidden
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
        // Moving a hidden note requires the same authorization as reading it,
        // otherwise a locked session could reorganize notes it can't see.
        if (existing.hidden === 1 && !(await canRevealHidden(ctx))) {
            throw new FeatureError('auth_required', 'Reveal hidden notes before moving');
        }
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
        // Deleting a hidden note also requires authorization — otherwise a locked
        // session could destroy notes it isn't allowed to even read.
        if (existing.hidden === 1 && !(await canRevealHidden(ctx))) {
            throw new FeatureError('auth_required', 'Reveal hidden notes before deleting');
        }
        await ctx.db.notes.delete(input.noteId, ctx.userId);
        return { noteId: input.noteId };
    }
});

export const noteRevealFeature: FeatureDefinition<
    typeof noteReveal.command,
    typeof noteReveal.input,
    typeof noteReveal.output
> = defineFeature({
    ...noteReveal,
    handler: async (ctx, input) => {
        // Already authorized (e.g. password-encryption session is unlocked)?
        // Accept without re-checking so the client need not re-prompt.
        if (await canRevealHidden(ctx)) {
            markRevealed(ctx.sessionId);
            return { revealed: true as const };
        }
        const user = await ctx.db.users.findById(ctx.userId);
        if (!user?.password_hash || !(await verifyPassword(user.password_hash, input.password))) {
            throw new FeatureError('auth_invalid', 'Mot de passe incorrect');
        }
        markRevealed(ctx.sessionId);
        return { revealed: true as const };
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
    noteRevealFeature,
    folderListFeature,
    folderAddFeature,
    folderRenameFeature,
    folderDeleteFeature
];
