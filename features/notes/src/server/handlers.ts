import {
    notesAdd,
    notesArchive,
    notesCount,
    notesDelete,
    notesEdit,
    notesFolderAdd,
    notesFolderDelete,
    notesFolderList,
    notesFolderRename,
    notesFolderReorder,
    notesGet,
    notesList,
    notesReorder,
    notesRestore
} from '../contracts/commands';
import { defineSdkFeature, FeatureError } from '@deveye/types/sdk/server';

import {
    assertPrivateAllowed,
    assertPrivateUnlocked,
    cipherFor,
    decryptFolder,
    decryptPayload,
    encryptFolder,
    encryptPayload,
    loadNote,
    resolveFolderId,
    toFolder,
    toMaskedSummary,
    toNote,
    toPayload,
    toSummary,
    tryDecryptPayload,
    WRITE,
    type Ctx
} from './_shared';

/**
 * Notes et dossiers, scopés à l'espace actif.
 *
 * L'espace vient de l'enveloppe WS et l'appartenance est déjà vérifiée par le
 * dispatcheur : les handlers filtrent sur `ctx.workspaceId`, sans garde ni
 * traduction d'id.
 *
 * Quatorze commandes sous le seul préfixe `notes.` : neuf sur les notes, un
 * verbe simple derrière le point (le filet `MUTATION_VERB` de `_topics.ts`
 * voit `add`, `edit`, `reorder`, `archive`, `restore` et `delete`, qui
 * déclarent bien `mutates`), et cinq sur les dossiers en camelCase
 * (`folderAdd`...), que le filet ne voit pas : leurs `mutates` se relisent à
 * la main. Les actions d'audit gardent leurs clés historiques (`note.create`,
 * `folder.create`...) : ce sont des chaînes libres, et le journal en porte
 * déjà des années. La catégorie d'audit, elle, suit le préfixe de la commande
 * (`notes`) : l'ancien `category: 'note'` des dossiers, qui corrigeait le
 * préfixe `folder`, n'a plus de raison d'être.
 */
export const notesHandlers = [
    defineSdkFeature({
        ...notesList,
        handler: async (ctx: Ctx, input) => {
            const wantArchived = input.archived === true;
            const rows = (await ctx.repo.listNotes(ctx.workspaceId)).filter(
                (r) => (r.archived_at !== null) === wantArchived
            );
            // The archive reads as a history: most recently archived first, rather
            // than in the user-defined order of the main list.
            if (wantArchived) rows.sort((a, b) => (b.archived_at ?? 0) - (a.archived_at ?? 0));

            // Never gated: the list always renders. Private notes are only revealed
            // if the DEK happens to be live, and we only ask (which slides the grace
            // window) when there is actually a private note to reveal.
            const canReadPrivate = rows.some((r) => r.is_private === 1) ? await ctx.secrecy.isUnlocked() : false;

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
                ctx.logger.warn({ skipped, total: rows.length }, 'notes.list: skipped undecryptable rows');
            }
            return { notes };
        }
    }),
    defineSdkFeature({
        ...notesCount,
        handler: async (ctx: Ctx) => {
            // Pure row count from clear metadata: no DEK, no unlock gate, and private
            // notes are counted like any other (no special case).
            return { count: await ctx.repo.countActiveNotes(ctx.workspaceId) };
        }
    }),
    defineSdkFeature({
        ...notesGet,
        handler: async (ctx: Ctx, input) => {
            const row = await loadNote(ctx, input.noteId);
            // A private note resolves the guarded DEK here, which throws `locked`
            // on its own when the session isn't unlocked.
            const payload = await decryptPayload(cipherFor(ctx, row.is_private === 1), row.content);
            if (!payload) throw new FeatureError('internal', 'Failed to decrypt note content');
            return { note: toNote(row, payload) };
        }
    }),
    defineSdkFeature({
        ...notesAdd,
        mutates: true,
        access: WRITE,
        handler: async (ctx: Ctx, input) => {
            assertPrivateAllowed(ctx, input.note.private);
            const folderId = await resolveFolderId(ctx, input.note.folderId);
            const content = await encryptPayload(cipherFor(ctx, input.note.private), toPayload(input.note));
            const row = await ctx.repo.createNote({
                userId: ctx.userId,
                workspaceId: ctx.workspaceId,
                folderId,
                content,
                isPrivate: input.note.private
            });
            ctx.audit({
                action: 'note.create',
                description: 'Note créée',
                metadata: { noteId: row.id, private: input.note.private }
            });
            return { note: toNote(row, toPayload(input.note)) };
        }
    }),
    defineSdkFeature({
        ...notesEdit,
        mutates: true,
        access: WRITE,
        handler: async (ctx: Ctx, input) => {
            const existing = await loadNote(ctx, input.noteId);
            assertPrivateAllowed(ctx, input.note.private);
            await assertPrivateUnlocked(ctx, existing);
            const folderId = await resolveFolderId(ctx, input.note.folderId);
            // Re-encrypting with the draft's tier is what moves a note between
            // public and private; the old ciphertext is replaced wholesale.
            const content = await encryptPayload(cipherFor(ctx, input.note.private), toPayload(input.note));
            const updated = await ctx.repo.updateNote(input.noteId, ctx.workspaceId, {
                folderId,
                content,
                isPrivate: input.note.private
            });
            if (!updated) throw new FeatureError('not_found', 'Note not found');
            ctx.audit({
                action: 'note.edit',
                description: 'Note modifiée',
                metadata: { noteId: input.noteId, private: input.note.private }
            });
            return { note: toNote(updated, toPayload(input.note)) };
        }
    }),
    defineSdkFeature({
        ...notesReorder,
        mutates: true,
        access: WRITE,
        handler: async (ctx: Ctx, input) => {
            const folderId = await resolveFolderId(ctx, input.folderId);
            // Reorder only the caller's own active notes in this workspace; any
            // foreign, archived or out-of-workspace id is dropped silently, the
            // same tolerance as notes.folderReorder.
            const eligible = new Set(
                (await ctx.repo.listNotes(ctx.workspaceId)).filter((r) => r.archived_at === null).map((r) => r.id)
            );
            const noteIds = input.noteIds.filter((id) => eligible.has(id));
            // Positioning never exposes nor rewrites a body, so a masked private
            // note can be re-filed and re-ranked without unlocking.
            await ctx.repo.reorderNotes(ctx.workspaceId, folderId, noteIds);
            return { folderId, noteIds };
        }
    }),
    defineSdkFeature({
        ...notesArchive,
        mutates: true,
        access: WRITE,
        handler: async (ctx: Ctx, input) => {
            const existing = await loadNote(ctx, input.noteId);
            await assertPrivateUnlocked(ctx, existing);
            await ctx.repo.archiveNote(input.noteId, ctx.workspaceId, Math.floor(Date.now() / 1000));
            ctx.audit({
                action: 'note.archive',
                description: 'Note archivée',
                metadata: { noteId: input.noteId }
            });
            return { noteId: input.noteId };
        }
    }),
    defineSdkFeature({
        ...notesRestore,
        mutates: true,
        access: WRITE,
        handler: async (ctx: Ctx, input) => {
            const existing = await loadNote(ctx, input.noteId);
            await assertPrivateUnlocked(ctx, existing);
            await ctx.repo.restoreNote(input.noteId, ctx.workspaceId);
            ctx.audit({
                action: 'note.restore',
                description: 'Note restaurée depuis les archives',
                metadata: { noteId: input.noteId }
            });
            return { noteId: input.noteId };
        }
    }),
    defineSdkFeature({
        ...notesDelete,
        mutates: true,
        access: WRITE,
        handler: async (ctx: Ctx, input) => {
            const existing = await loadNote(ctx, input.noteId);
            // Two-step by construction: an active note is archived first, never
            // destroyed outright. Enforced here so no caller can shortcut it.
            if (existing.archived_at === null) {
                throw new FeatureError('conflict', 'Archive the note before deleting it permanently');
            }
            await assertPrivateUnlocked(ctx, existing);
            await ctx.repo.deleteNote(input.noteId, ctx.workspaceId);
            ctx.audit({
                action: 'note.delete',
                level: 'warning',
                description: 'Note supprimée définitivement',
                metadata: { noteId: input.noteId }
            });
            return { noteId: input.noteId };
        }
    }),
    defineSdkFeature({
        ...notesFolderList,
        handler: async (ctx: Ctx) => {
            const rows = await ctx.repo.listFolders(ctx.workspaceId);
            const folders = await Promise.all(
                rows.map(async (r) => toFolder(r, await decryptFolder(ctx.cipher(), r.content)))
            );
            return { folders };
        }
    }),
    defineSdkFeature({
        ...notesFolderAdd,
        mutates: true,
        access: WRITE,
        handler: async (ctx: Ctx, input) => {
            const name = input.name.trim();
            const content = await encryptFolder(ctx.cipher(), { name });
            const row = await ctx.repo.createFolder({
                userId: ctx.userId,
                workspaceId: ctx.workspaceId,
                content
            });
            ctx.audit({
                action: 'folder.create',
                description: 'Dossier de notes créé',
                metadata: { folderId: row.id }
            });
            return { folder: toFolder(row, { name }) };
        }
    }),
    defineSdkFeature({
        ...notesFolderRename,
        mutates: true,
        access: WRITE,
        handler: async (ctx: Ctx, input) => {
            const existing = await ctx.repo.findFolder(input.folderId, ctx.workspaceId);
            if (!existing) throw new FeatureError('not_found', 'Folder not found');
            const name = input.name.trim();
            const content = await encryptFolder(ctx.cipher(), { name });
            const updated = await ctx.repo.updateFolder(input.folderId, ctx.workspaceId, content);
            if (!updated) throw new FeatureError('not_found', 'Folder not found');
            ctx.audit({
                action: 'folder.rename',
                description: 'Dossier de notes renommé',
                metadata: { folderId: input.folderId }
            });
            return { folder: toFolder(updated, { name }) };
        }
    }),
    defineSdkFeature({
        ...notesFolderReorder,
        mutates: true,
        access: WRITE,
        handler: async (ctx: Ctx, input) => {
            // Reorder only the rows of this workspace; any foreign id in
            // `folderIds` is dropped silently.
            const owned = await ctx.repo.listFolders(ctx.workspaceId);
            const ownedIds = new Set(owned.map((r) => r.id));
            const orderedIds = input.folderIds.filter((id) => ownedIds.has(id));
            const rows = await ctx.repo.reorderFolders(ctx.workspaceId, orderedIds);
            const folders = await Promise.all(
                rows.map(async (r) => toFolder(r, await decryptFolder(ctx.cipher(), r.content)))
            );
            return { folders };
        }
    }),
    defineSdkFeature({
        ...notesFolderDelete,
        mutates: true,
        access: WRITE,
        handler: async (ctx: Ctx, input) => {
            const existing = await ctx.repo.findFolder(input.folderId, ctx.workspaceId);
            if (!existing) throw new FeatureError('not_found', 'Folder not found');
            // The notes it holds are un-filed by the FK (ON DELETE SET NULL) with the
            // ranks they had inside the folder, which would interleave them into the
            // unfiled list. Append them at its end instead, so the user's order stays
            // meaningful and every rank stays unique within its bucket.
            const active = (await ctx.repo.listNotes(ctx.workspaceId)).filter((r) => r.archived_at === null);
            const unfiled = active.filter((r) => r.folder_id === null).map((r) => r.id);
            const orphans = active.filter((r) => r.folder_id === input.folderId).map((r) => r.id);
            await ctx.repo.deleteFolder(input.folderId, ctx.workspaceId);
            if (orphans.length > 0) await ctx.repo.reorderNotes(ctx.workspaceId, null, [...unfiled, ...orphans]);
            ctx.audit({
                action: 'folder.delete',
                level: 'warning',
                description: 'Dossier de notes supprimé',
                metadata: { folderId: input.folderId }
            });
            return { folderId: input.folderId };
        }
    })
];
