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
    bodyCipher,
    cipherFor,
    decryptFolder,
    decryptPayload,
    encryptFolder,
    encryptPayload,
    isForeign,
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
 * Notes et dossiers, scopés à l'espace actif, plus les notes qu'un autre
 * espace y projette.
 *
 * L'espace vient de l'enveloppe WS et l'appartenance est déjà vérifiée par le
 * dispatcheur : les handlers filtrent sur `ctx.workspaceId`. Une note projetée
 * (`Docs/SHARING.md`) se lit et s'écrit chez elle, sous le codec ouvert de son
 * domicile (`ctx.sharing.scope()`, ligne par ligne) ; les droits restent ceux
 * de l'espace actif (`ctx.items.assert`). Depuis la fenêtre, tout se fait sauf
 * la classer (dossier, rang), la passer en privé et la détruire.
 *
 * Les verbes camelCase des dossiers (`notes.folderAdd`...) échappent au filet
 * `MUTATION_VERB` de `_topics.ts` : leur `mutates` se relit à la main. Les
 * actions d'audit gardent leurs clés `note.*` / `folder.*` : le journal en
 * porte déjà des années.
 */
export const notesHandlers = [
    defineSdkFeature({
        ...notesList,
        handler: async (ctx: Ctx, input) => {
            const wantArchived = input.archived === true;
            const [visible, hidden, scope] = await Promise.all([
                ctx.repo.listVisible(ctx.workspaceId),
                ctx.items.restrictions(),
                ctx.sharing.scope()
            ]);
            // Une note masquée pour ce rôle disparaît plutôt que de figurer
            // grisée : la voir apprend déjà qu'elle existe.
            const rows = visible.filter(
                (r) => hidden.get(String(r.id)) !== 'none' && (r.archived_at !== null) === wantArchived
            );
            // The archive reads as a history: most recently archived first.
            if (wantArchived) rows.sort((a, b) => (b.archived_at ?? 0) - (a.archived_at ?? 0));

            // Only ask the lock when there is a private note to reveal: asking
            // slides the grace window.
            const canReadPrivate = rows.some((r) => r.is_private === 1) ? await ctx.secrecy.isUnlocked() : false;

            let skipped = 0;
            const notes = (
                await Promise.all(
                    rows.map(async (r) => {
                        const isPrivate = r.is_private === 1;
                        if (isPrivate && !canReadPrivate) return toMaskedSummary(r);
                        const payload = await tryDecryptPayload(await bodyCipher(ctx, scope, r), r.content);
                        if (!payload) {
                            // Corrupt row (or a key that no longer matches): drop it rather than fail the list.
                            skipped += 1;
                            return null;
                        }
                        return toSummary(r, payload, isForeign(ctx, r));
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
            // Les mêmes lignes que la liste, comptées sur les métadonnées
            // claires : aucune DEK, aucun verrou.
            const [visible, hidden] = await Promise.all([
                ctx.repo.listVisible(ctx.workspaceId),
                ctx.items.restrictions()
            ]);
            return {
                count: visible.filter((r) => r.archived_at === null && hidden.get(String(r.id)) !== 'none').length
            };
        }
    }),
    defineSdkFeature({
        ...notesGet,
        handler: async (ctx: Ctx, input) => {
            const row = await loadNote(ctx, input.noteId);
            const scope = await ctx.sharing.scope();
            // A private note resolves the guarded DEK here, which throws `locked` on its own.
            const payload = await decryptPayload(await bodyCipher(ctx, scope, row), row.content);
            if (!payload) throw new FeatureError('internal', 'Failed to decrypt note content');
            return { note: toNote(row, payload, isForeign(ctx, row)) };
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
            return { note: toNote(row, toPayload(input.note), false) };
        }
    }),
    defineSdkFeature({
        ...notesEdit,
        mutates: true,
        access: WRITE,
        handler: async (ctx: Ctx, input) => {
            const existing = await loadNote(ctx, input.noteId, 'write');
            const foreign = isForeign(ctx, existing);
            if (foreign) {
                // Depuis une fenêtre, seul le corps se réécrit. En privé, elle
                // serait chiffrée par le mot de passe d'un membre d'ici, donc
                // illisible chez elle ; dans un dossier d'ici, elle relierait
                // sa donnée à un classement que son domicile ne voit pas.
                if (input.note.private) {
                    throw new FeatureError(
                        'validation',
                        'Cette note appartient à un autre espace : elle ne peut pas devenir privée depuis ici.'
                    );
                }
                if (input.note.folderId !== null) {
                    throw new FeatureError(
                        'validation',
                        'Cette note appartient à un autre espace : elle ne se range pas dans un dossier d’ici.'
                    );
                }
            }
            assertPrivateAllowed(ctx, input.note.private);
            await assertPrivateUnlocked(ctx, existing);
            const becomesPrivate = input.note.private && existing.is_private === 0;
            // Le dossier d'une note projetée est le sien, chez elle : gardé tel
            // quel plutôt qu'écrasé par le « sans dossier » que le client renvoie.
            const folderId = foreign ? existing.folder_id : await resolveFolderId(ctx, input.note.folderId);
            // Re-encrypting with the draft's tier is what moves a note between
            // tiers. Une note ordinaire est réécrite sous la clé ouverte de son
            // domicile : la chiffrer avec celle d'ici la rendrait illisible chez elle.
            const scope = await ctx.sharing.scope();
            const cipher = input.note.private ? ctx.cipher('private') : await scope.cipherFor(String(input.noteId));
            const content = await encryptPayload(cipher, toPayload(input.note));
            const updated = await ctx.repo.updateNote(input.noteId, existing.workspace_id, {
                folderId,
                content,
                isPrivate: input.note.private
            });
            if (!updated) throw new FeatureError('not_found', 'Note not found');
            // Devenue privée, plus aucun autre espace ne peut la lire : ses
            // projections partent, et ses restrictions avec (une note privée
            // n'existe que dans un espace personnel, sans restriction de rôle).
            if (becomesPrivate) await ctx.items.forget(String(input.noteId));
            ctx.audit({
                action: 'note.edit',
                description: 'Note modifiée',
                metadata: { noteId: input.noteId, private: input.note.private }
            });
            return { note: toNote(updated, toPayload(input.note), foreign) };
        }
    }),
    defineSdkFeature({
        ...notesReorder,
        mutates: true,
        access: WRITE,
        handler: async (ctx: Ctx, input) => {
            const folderId = await resolveFolderId(ctx, input.folderId);
            // Une note projetée se classe chez elle. Refus franc plutôt
            // qu'abandon silencieux : le client ne la propose pas au glisser,
            // un appel qui l'inclut est une erreur à voir.
            const scope = await ctx.sharing.scope();
            if (input.noteIds.some((id) => scope.foreignIds.has(String(id)))) {
                throw new FeatureError(
                    'validation',
                    'Une note partagée depuis un autre espace se classe chez elle, pas ici.'
                );
            }
            // Any archived, out-of-workspace or role-restricted id is dropped
            // silently, the same tolerance as notes.folderReorder.
            const hidden = await ctx.items.restrictions();
            const eligible = new Set(
                (await ctx.repo.listNotes(ctx.workspaceId))
                    .filter((r) => r.archived_at === null && !hidden.has(String(r.id)))
                    .map((r) => r.id)
            );
            const noteIds = input.noteIds.filter((id) => eligible.has(id));
            // Positioning never touches a body, so a masked private note can be re-filed without unlocking.
            await ctx.repo.reorderNotes(ctx.workspaceId, folderId, noteIds);
            return { folderId, noteIds };
        }
    }),
    defineSdkFeature({
        ...notesArchive,
        mutates: true,
        access: WRITE,
        handler: async (ctx: Ctx, input) => {
            const existing = await loadNote(ctx, input.noteId, 'write');
            await assertPrivateUnlocked(ctx, existing);
            // Chez elle, même depuis une fenêtre : la note disparaît de toutes ses fenêtres à la fois.
            await ctx.repo.archiveNote(input.noteId, existing.workspace_id, Math.floor(Date.now() / 1000));
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
            const existing = await loadNote(ctx, input.noteId, 'write');
            await assertPrivateUnlocked(ctx, existing);
            await ctx.repo.restoreNote(input.noteId, existing.workspace_id);
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
            const existing = await loadNote(ctx, input.noteId, 'write');
            // Supprimer depuis un espace qui ne fait que la voir détruirait la
            // donnée d'un autre ; retirer la projection est le rôle de `share.set`.
            if (isForeign(ctx, existing)) {
                throw new FeatureError(
                    'forbidden',
                    'Cette note appartient à un autre espace. Retirez-la d’ici depuis ses réglages de partage, ou supprimez-la depuis son espace d’origine.'
                );
            }
            // Two-step by construction: an active note is archived first, never destroyed outright.
            if (existing.archived_at === null) {
                throw new FeatureError('conflict', 'Archive the note before deleting it permanently');
            }
            await assertPrivateUnlocked(ctx, existing);
            await ctx.repo.deleteNote(input.noteId, ctx.workspaceId);
            // Projections et restrictions ne sont rattachées par aucune clé
            // étrangère : sans ce ménage, une ligne orpheline s'appliquerait à
            // la prochaine note à hériter de l'identifiant.
            await ctx.items.forget(String(input.noteId));
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
            // Any foreign id in `folderIds` is dropped silently.
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
            // The FK (ON DELETE SET NULL) un-files the notes with the ranks they
            // had inside the folder, which would interleave them into the
            // unfiled list: append them at its end instead. Les notes projetées
            // ici se classent chez elles.
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
