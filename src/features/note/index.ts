import {
    folderAdd,
    folderDelete,
    folderList,
    folderRename,
    folderReorder,
    noteAdd,
    noteArchive,
    noteCount,
    noteDelete,
    noteEdit,
    noteGet,
    noteList,
    noteReorder,
    noteRestore
} from 'deveye-types';
import type { NoteRow } from 'deveye-types';
import type { Cipher } from '@/Services/SecureStore';
import { defineFeature, FeatureError, type FeatureContext, type FeatureDefinition } from '../_define';
import {
    decryptFolder,
    decryptPayload,
    encryptFolder,
    encryptPayload,
    toFolder,
    toMaskedSummary,
    toNote,
    toSummary,
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

/** Load one of the caller's notes in this workspace, or throw `not_found`. */
async function loadNote(ctx: FeatureContext, workspaceId: number, noteId: number): Promise<NoteRow> {
    const row = await ctx.db.notes.findById(noteId, ctx.userId);
    if (!row || !rowInWorkspace(row.workspace_id, workspaceId)) {
        throw new FeatureError('not_found', 'Note not found');
    }
    return row;
}

/**
 * The tier a note's body lives in: private notes use the password-protected DEK,
 * everything else the open one. Picking the cipher IS the access control — a
 * private note simply can't be read or written while the session is locked.
 */
function cipherFor(ctx: FeatureContext, isPrivate: boolean): Cipher {
    return isPrivate ? ctx.secure : ctx.secure.open;
}

/**
 * Guard the destructive/rewriting paths on an existing private note. Encryption
 * alone protects reads, but an edit or a delete never needs to *read* the body —
 * without this, a locked session could overwrite or destroy a note it can't see.
 * Throws `locked`, which the client turns into the usual unlock prompt.
 */
async function assertPrivateUnlocked(ctx: FeatureContext, row: NoteRow): Promise<void> {
    if (row.is_private !== 1) return;
    if (!(await ctx.secure.isUnlocked())) {
        throw new FeatureError('locked', 'Password encryption is locked; unlock with your password');
    }
}

/** Normalize a draft into the encrypted payload (the rest lives in clear columns). */
function toPayload(draft: { title: string; blocks: StoredPayload['blocks'] }): StoredPayload {
    return { title: draft.title, blocks: draft.blocks };
}

export const noteListFeature: FeatureDefinition<
    typeof noteList.command,
    typeof noteList.input,
    typeof noteList.output
> = defineFeature({
    ...noteList,
    handler: async (ctx, input) => {
        await assertWorkspaceMember(ctx, input.workspaceId);
        const wantArchived = input.archived === true;
        const rows = (await ctx.db.notes.listByUser(ctx.userId)).filter(
            (r) => rowInWorkspace(r.workspace_id, input.workspaceId) && (r.archived_at !== null) === wantArchived
        );
        // The archive reads as a history: most recently archived first, rather
        // than in the user-defined order of the main list.
        if (wantArchived) rows.sort((a, b) => (b.archived_at ?? 0) - (a.archived_at ?? 0));

        // Never gated: the list always renders. Private notes are only revealed
        // if the DEK happens to be live — and we only ask (which slides the grace
        // window) when there is actually a private note to reveal.
        const canReadPrivate = rows.some((r) => r.is_private === 1) ? await ctx.secure.isUnlocked() : false;

        let skipped = 0;
        const notes = (
            await Promise.all(
                rows.map(async (r) => {
                    const isPrivate = r.is_private === 1;
                    if (isPrivate && !canReadPrivate) return toMaskedSummary(r);
                    const payload = await tryDecryptPayload(cipherFor(ctx, isPrivate), r.content);
                    if (!payload) {
                        // Corrupt row (or a key that no longer matches): drop it
                        // rather than fail the whole list.
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

export const noteCountFeature: FeatureDefinition<
    typeof noteCount.command,
    typeof noteCount.input,
    typeof noteCount.output
> = defineFeature({
    ...noteCount,
    handler: async (ctx, input) => {
        await assertWorkspaceMember(ctx, input.workspaceId);
        // Pure row count from clear metadata: no DEK, no unlock gate, and private
        // notes are counted like any other (no special case).
        const rows = await ctx.db.notes.listByUser(ctx.userId);
        const count = rows.filter(
            (r) => rowInWorkspace(r.workspace_id, input.workspaceId) && r.archived_at === null
        ).length;
        return { count };
    }
});

export const noteGetFeature: FeatureDefinition<typeof noteGet.command, typeof noteGet.input, typeof noteGet.output> =
    defineFeature({
        ...noteGet,
        handler: async (ctx, input) => {
            await assertWorkspaceMember(ctx, input.workspaceId);
            const row = await loadNote(ctx, input.workspaceId, input.noteId);
            // A private note resolves the guarded DEK here, which throws `locked`
            // on its own when the session isn't unlocked.
            const payload = await decryptPayload(cipherFor(ctx, row.is_private === 1), row.content);
            if (!payload) throw new FeatureError('internal', 'Failed to decrypt note content');
            return { note: toNote(row, payload) };
        }
    });

export const noteAddFeature: FeatureDefinition<typeof noteAdd.command, typeof noteAdd.input, typeof noteAdd.output> =
    defineFeature({
        ...noteAdd,
        handler: async (ctx, input) => {
            await assertWorkspaceMember(ctx, input.workspaceId);
            const folderId = await resolveFolderId(ctx, input.workspaceId, input.note.folderId);
            const content = await encryptPayload(cipherFor(ctx, input.note.private), toPayload(input.note));
            const row = await ctx.db.notes.create({
                userId: ctx.userId,
                workspaceId: toDbWorkspaceId(input.workspaceId),
                folderId,
                content,
                isPrivate: input.note.private
            });
            ctx.audit({
                action: 'note.create',
                description: 'Note créée',
                metadata: { noteId: row.id, workspaceId: input.workspaceId, private: input.note.private }
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
        const existing = await loadNote(ctx, input.workspaceId, input.noteId);
        await assertPrivateUnlocked(ctx, existing);
        const folderId = await resolveFolderId(ctx, input.workspaceId, input.note.folderId);
        // Re-encrypting with the draft's tier is what moves a note between
        // public and private; the old ciphertext is replaced wholesale.
        const content = await encryptPayload(cipherFor(ctx, input.note.private), toPayload(input.note));
        const updated = await ctx.db.notes.update(input.noteId, ctx.userId, {
            folderId,
            content,
            isPrivate: input.note.private
        });
        if (!updated) throw new FeatureError('not_found', 'Note not found');
        ctx.audit({
            action: 'note.edit',
            description: 'Note modifiée',
            metadata: { noteId: input.noteId, workspaceId: input.workspaceId, private: input.note.private }
        });
        return { note: toNote(updated, toPayload(input.note)) };
    }
});

export const noteReorderFeature: FeatureDefinition<
    typeof noteReorder.command,
    typeof noteReorder.input,
    typeof noteReorder.output
> = defineFeature({
    ...noteReorder,
    handler: async (ctx, input) => {
        await assertWorkspaceMember(ctx, input.workspaceId);
        const folderId = await resolveFolderId(ctx, input.workspaceId, input.folderId);
        // Reorder only the caller's own active notes in this workspace; any
        // foreign, archived or out-of-workspace id is dropped silently — the
        // same tolerance as folder.reorder.
        const eligible = new Set(
            (await ctx.db.notes.listByUser(ctx.userId))
                .filter((r) => rowInWorkspace(r.workspace_id, input.workspaceId) && r.archived_at === null)
                .map((r) => r.id)
        );
        const noteIds = input.noteIds.filter((id) => eligible.has(id));
        // Positioning never exposes nor rewrites a body, so a masked private
        // note can be re-filed and re-ranked without unlocking.
        await ctx.db.notes.reorder(ctx.userId, folderId, noteIds);
        return { folderId, noteIds };
    }
});

export const noteArchiveFeature: FeatureDefinition<
    typeof noteArchive.command,
    typeof noteArchive.input,
    typeof noteArchive.output
> = defineFeature({
    ...noteArchive,
    handler: async (ctx, input) => {
        await assertWorkspaceMember(ctx, input.workspaceId);
        const existing = await loadNote(ctx, input.workspaceId, input.noteId);
        await assertPrivateUnlocked(ctx, existing);
        await ctx.db.notes.archive(input.noteId, ctx.userId, Math.floor(Date.now() / 1000));
        ctx.audit({
            action: 'note.archive',
            description: 'Note archivée',
            metadata: { noteId: input.noteId, workspaceId: input.workspaceId }
        });
        return { noteId: input.noteId };
    }
});

export const noteRestoreFeature: FeatureDefinition<
    typeof noteRestore.command,
    typeof noteRestore.input,
    typeof noteRestore.output
> = defineFeature({
    ...noteRestore,
    handler: async (ctx, input) => {
        await assertWorkspaceMember(ctx, input.workspaceId);
        const existing = await loadNote(ctx, input.workspaceId, input.noteId);
        await assertPrivateUnlocked(ctx, existing);
        await ctx.db.notes.restore(input.noteId, ctx.userId);
        ctx.audit({
            action: 'note.restore',
            description: 'Note restaurée depuis les archives',
            metadata: { noteId: input.noteId, workspaceId: input.workspaceId }
        });
        return { noteId: input.noteId };
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
        const existing = await loadNote(ctx, input.workspaceId, input.noteId);
        // Two-step by construction: an active note is archived first, never
        // destroyed outright. Enforced here so no caller can shortcut it.
        if (existing.archived_at === null) {
            throw new FeatureError('conflict', 'Archive the note before deleting it permanently');
        }
        await assertPrivateUnlocked(ctx, existing);
        await ctx.db.notes.delete(input.noteId, ctx.userId);
        ctx.audit({
            action: 'note.delete',
            level: 'warning',
            description: 'Note supprimée définitivement',
            metadata: { noteId: input.noteId, workspaceId: input.workspaceId }
        });
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
        const rows = (await ctx.db.noteFolders.listByUser(ctx.userId)).filter((r) =>
            rowInWorkspace(r.workspace_id, input.workspaceId)
        );
        const folders = await Promise.all(
            rows.map(async (r) => toFolder(r, await decryptFolder(ctx.secure.open, r.content)))
        );
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
        const name = input.name.trim();
        const content = await encryptFolder(ctx.secure.open, { name });
        const row = await ctx.db.noteFolders.create({
            userId: ctx.userId,
            workspaceId: toDbWorkspaceId(input.workspaceId),
            content
        });
        ctx.audit({
            category: 'note',
            action: 'folder.create',
            description: 'Dossier de notes créé',
            metadata: { folderId: row.id, workspaceId: input.workspaceId }
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
        const existing = await ctx.db.noteFolders.findById(input.folderId, ctx.userId);
        if (!existing || !rowInWorkspace(existing.workspace_id, input.workspaceId)) {
            throw new FeatureError('not_found', 'Folder not found');
        }
        const name = input.name.trim();
        const content = await encryptFolder(ctx.secure.open, { name });
        const updated = await ctx.db.noteFolders.update(input.folderId, ctx.userId, content);
        if (!updated) throw new FeatureError('not_found', 'Folder not found');
        ctx.audit({
            category: 'note',
            action: 'folder.rename',
            description: 'Dossier de notes renommé',
            metadata: { folderId: input.folderId, workspaceId: input.workspaceId }
        });
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
        const folders = await Promise.all(
            rows.map(async (r) => toFolder(r, await decryptFolder(ctx.secure.open, r.content)))
        );
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
        // The notes it holds are un-filed by the FK (ON DELETE SET NULL) with the
        // ranks they had inside the folder, which would interleave them into the
        // unfiled list. Append them at its end instead, so the user's order stays
        // meaningful and every rank stays unique within its bucket.
        const active = (await ctx.db.notes.listByUser(ctx.userId)).filter(
            (r) => rowInWorkspace(r.workspace_id, input.workspaceId) && r.archived_at === null
        );
        const unfiled = active.filter((r) => r.folder_id === null).map((r) => r.id);
        const orphans = active.filter((r) => r.folder_id === input.folderId).map((r) => r.id);
        await ctx.db.noteFolders.delete(input.folderId, ctx.userId);
        if (orphans.length > 0) await ctx.db.notes.reorder(ctx.userId, null, [...unfiled, ...orphans]);
        ctx.audit({
            category: 'note',
            action: 'folder.delete',
            level: 'warning',
            description: 'Dossier de notes supprimé',
            metadata: { folderId: input.folderId, workspaceId: input.workspaceId }
        });
        return { folderId: input.folderId };
    }
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const noteFeatures: FeatureDefinition<string, any, any>[] = [
    noteListFeature,
    noteCountFeature,
    noteGetFeature,
    noteAddFeature,
    noteEditFeature,
    noteReorderFeature,
    noteArchiveFeature,
    noteRestoreFeature,
    noteDeleteFeature,
    folderListFeature,
    folderAddFeature,
    folderRenameFeature,
    folderReorderFeature,
    folderDeleteFeature
];
