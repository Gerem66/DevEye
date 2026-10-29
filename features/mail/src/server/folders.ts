import {
    mailFolderBackfill,
    mailFolderCreate,
    mailFolderDelete,
    mailFolderList,
    mailFolderPrefetch,
    mailFolderRename,
    mailFolderReorder,
    mailFolderReset,
    mailFolderSync
} from '../contracts/commands';
import type { MailAccountRow, MailFolderRow } from '../contracts/domain';
import { defineSdkFeature, FeatureError, logFailure, type SdkCipher } from '@deveye/types/sdk/server';

import type { MailRepo } from './repo';
import {
    backfillFolder,
    MAIL_BODY_PREFETCH_BATCH,
    prefetchFolderBodies,
    purgeStaleBodies,
    resetFolder,
    syncAccountFolders,
    syncOneFolder
} from './sync';
import {
    accountCipher,
    accountOfFolder,
    assertMailUnlocked,
    classifyMailError,
    isOwnerSideMailError,
    loadAccount,
    loadFolderWithAccount,
    sessionFor,
    toFolderDTO,
    WRITE,
    type Ctx
} from './_shared';

/**
 * Les dossiers d'un compte : leur liste, leur ordre, et les trois relèves à la
 * demande (incrémentale, vers le passé, à zéro), qui passent toutes par le même
 * `sync.ts` que le service de fond.
 *
 * Tout fonctionne sur un compte projeté d'un autre espace : le codec est celui
 * du domicile (`accountCipher`), et une relève faite depuis la fenêtre écrit le
 * cache du domicile.
 */

/** Délai avant la seconde tentative de la toute première synchro. */
const INITIAL_SYNC_RETRY_MS = 1500;

/**
 * La toute première liste de dossiers d'une boîte, avec une seconde chance.
 *
 * C'est le moment où Gmail refuse le plus volontiers, son stockage ne rendant
 * pas encore une boîte dont l'autorisation vient d'être accordée (« Lookup
 * failed »). Sans reprise, la boîte s'ouvrait vide et le rester jusqu'à ce que
 * quelqu'un rouvre la feature. Une seule reprise, et seulement sur un refus
 * passager : deux tentatives contre un mot de passe faux ne valent pas mieux
 * qu'une, et retenter contre un serveur muet ferait attendre deux fois.
 */
async function syncFoldersWithRetry(ctx: Ctx, account: MailAccountRow, cipher: SdkCipher): Promise<MailFolderRow[]> {
    const attempt = () =>
        sessionFor(ctx, account, cipher, (session) => syncAccountFolders(session, ctx.repo, cipher, account.id));
    try {
        return await attempt();
    } catch (e) {
        if (classifyMailError(e) !== 'unreachable') throw e;
        await new Promise((resolve) => setTimeout(resolve, INITIAL_SYNC_RETRY_MS));
        return attempt();
    }
}

export const mailFolderListFeature = defineSdkFeature<
    MailRepo,
    typeof mailFolderList.command,
    typeof mailFolderList.input,
    typeof mailFolderList.output
>({
    ...mailFolderList,
    handler: async (ctx, input) => {
        const account = await loadAccount(ctx, input.accountId);
        await assertMailUnlocked(ctx, account.security_tier);
        const cipher = await accountCipher(ctx, account);

        // "Open" accounts are kept fresh by the background tick, so serving the
        // cache makes switching mailboxes instant instead of round-tripping to
        // IMAP on every click. "Guarded" accounts have no background sync, so
        // this on-demand call is their only chance to refresh.
        // En pause d'offre, la boîte se lit dans son cache, quel que soit le
        // palier : ouvrir un compte n'est pas un geste qui doit buter sur l'offre.
        const paused = ctx.quota.isPaused('accounts', String(account.id));
        let rows =
            account.security_tier === 'guarded' && !paused ? [] : await ctx.repo.folders.listByAccount(account.id);
        if (rows.length === 0 && !paused) {
            try {
                rows = await syncFoldersWithRetry(ctx, account, cipher);
            } catch (e) {
                if (account.security_tier === 'guarded') throw e;
                // Open account, first-ever load, sync unreachable: serve whatever
                // is cached rather than failing the whole switch.
                logFailure(
                    ctx.logger,
                    isOwnerSideMailError(e),
                    { accountId: account.id, err: e instanceof Error ? e.message : String(e) },
                    'mail.folderList: initial sync failed'
                );
                rows = await ctx.repo.folders.listByAccount(account.id);
            }
        }
        return { folders: await Promise.all(rows.map((row) => toFolderDTO(cipher, row))) };
    }
});

/** Un dossier que les clients repèrent à son rôle : le serveur refuserait souvent, et l'écran ne le propose pas. */
function assertPlainFolder(folder: MailFolderRow, gesture: string): void {
    if (folder.special_use === 'other') return;
    throw new FeatureError('validation', `Ce dossier a un rôle pour le serveur de mail : ${gesture} impossible.`);
}

export const mailFolderCreateFeature = defineSdkFeature<
    MailRepo,
    typeof mailFolderCreate.command,
    typeof mailFolderCreate.input,
    typeof mailFolderCreate.output
>({
    ...mailFolderCreate,
    access: { ...WRITE, item: 'accountId' },
    mutates: true,
    handler: async (ctx, input) => {
        const account = await loadAccount(ctx, input.accountId, 'write');
        const parent = input.parentId === null ? null : await ctx.repo.folders.findById(input.parentId);
        if (input.parentId !== null && (!parent || parent.account_id !== account.id)) {
            throw new FeatureError('not_found', 'Dossier parent introuvable');
        }
        await assertMailUnlocked(ctx, account.security_tier);
        const cipher = await accountCipher(ctx, account);
        const path = await sessionFor(ctx, account, cipher, async (session) => {
            const created = await session.createFolder(parent ? [parent.imap_path, input.name] : input.name);
            await syncAccountFolders(session, ctx.repo, cipher, account.id);
            return created;
        });
        const folder = await ctx.repo.folders.findByImapPath(account.id, path);
        if (!folder) throw new FeatureError('not_found', 'Le dossier créé n’apparaît pas dans la liste du serveur');
        return { folder: await toFolderDTO(cipher, folder) };
    }
});

export const mailFolderRenameFeature = defineSdkFeature<
    MailRepo,
    typeof mailFolderRename.command,
    typeof mailFolderRename.input,
    typeof mailFolderRename.output
>({
    ...mailFolderRename,
    access: { ...WRITE, item: accountOfFolder },
    mutates: true,
    handler: async (ctx, input) => {
        const { folder, account } = await loadFolderWithAccount(ctx, input.folderId, 'write');
        assertPlainFolder(folder, 'le renommer est');
        await assertMailUnlocked(ctx, account.security_tier);
        const cipher = await accountCipher(ctx, account);
        await sessionFor(ctx, account, cipher, async (session) => {
            const path = await session.renameFolder(folder.imap_path, input.name);
            // En place d'abord, pour que la relecture le retrouve sous son
            // nouveau chemin et garde son cache ; ses sous-dossiers, eux, sont
            // recréés par la relecture.
            await ctx.repo.folders.rename(folder.id, path, await cipher.encrypt(input.name));
            await syncAccountFolders(session, ctx.repo, cipher, account.id);
        });
        const renamed = await ctx.repo.folders.findById(folder.id);
        if (!renamed) throw new FeatureError('not_found', 'Dossier introuvable');
        return { folder: await toFolderDTO(cipher, renamed) };
    }
});

export const mailFolderDeleteFeature = defineSdkFeature<
    MailRepo,
    typeof mailFolderDelete.command,
    typeof mailFolderDelete.input,
    typeof mailFolderDelete.output
>({
    ...mailFolderDelete,
    access: { ...WRITE, item: accountOfFolder },
    mutates: true,
    handler: async (ctx, input) => {
        const { folder, account } = await loadFolderWithAccount(ctx, input.folderId, 'write');
        assertPlainFolder(folder, 'le supprimer est');
        await assertMailUnlocked(ctx, account.security_tier);
        const cipher = await accountCipher(ctx, account);
        await sessionFor(ctx, account, cipher, async (session) => {
            await session.deleteFolder(folder.imap_path);
            // La relecture le retire du cache, avec ses messages.
            await syncAccountFolders(session, ctx.repo, cipher, account.id);
        });
        return { id: folder.id };
    }
});

export const mailFolderReorderFeature = defineSdkFeature<
    MailRepo,
    typeof mailFolderReorder.command,
    typeof mailFolderReorder.input,
    typeof mailFolderReorder.output
>({
    ...mailFolderReorder,
    access: { ...WRITE, item: 'accountId' },
    mutates: true,
    handler: async (ctx, input) => {
        await loadAccount(ctx, input.accountId, 'write');
        await ctx.repo.folders.reorder(input.accountId, input.ids);
        return { ids: input.ids };
    }
});

export const mailFolderSyncFeature = defineSdkFeature<
    MailRepo,
    typeof mailFolderSync.command,
    typeof mailFolderSync.input,
    typeof mailFolderSync.output
>({
    ...mailFolderSync,
    access: { ...WRITE, item: accountOfFolder },
    mutates: true,
    handler: async (ctx, input) => {
        const { folder, account } = await loadFolderWithAccount(ctx, input.folderId, 'write');
        await assertMailUnlocked(ctx, account.security_tier);
        const cipher = await accountCipher(ctx, account);
        const outcome = await sessionFor(ctx, account, cipher, (session) =>
            syncOneFolder(session, ctx.repo, cipher, folder)
        );
        return { ok: true, ...outcome };
    }
});

export const mailFolderPrefetchFeature = defineSdkFeature<
    MailRepo,
    typeof mailFolderPrefetch.command,
    typeof mailFolderPrefetch.input,
    typeof mailFolderPrefetch.output
>({
    ...mailFolderPrefetch,
    handler: async (ctx, input) => {
        const { folder, account } = await loadFolderWithAccount(ctx, input.folderId);
        await assertMailUnlocked(ctx, account.security_tier);
        const cipher = await accountCipher(ctx, account);
        // Un lot court par appel : la commande doit répondre bien avant le délai
        // du client, et c'est l'écran qui enchaîne.
        const outcome = await sessionFor(ctx, account, cipher, (session) =>
            prefetchFolderBodies(session, ctx.repo, cipher, folder, MAIL_BODY_PREFETCH_BATCH)
        );
        await purgeStaleBodies(ctx.repo, account.id);
        return outcome;
    }
});

export const mailFolderBackfillFeature = defineSdkFeature<
    MailRepo,
    typeof mailFolderBackfill.command,
    typeof mailFolderBackfill.input,
    typeof mailFolderBackfill.output
>({
    ...mailFolderBackfill,
    access: { ...WRITE, item: accountOfFolder },
    mutates: true,
    handler: async (ctx, input) => {
        const { folder, account } = await loadFolderWithAccount(ctx, input.folderId, 'write');
        await assertMailUnlocked(ctx, account.security_tier);
        const cipher = await accountCipher(ctx, account);
        return sessionFor(ctx, account, cipher, (session) =>
            backfillFolder(session, ctx.repo, cipher, folder, input.limit)
        );
    }
});

export const mailFolderResetFeature = defineSdkFeature<
    MailRepo,
    typeof mailFolderReset.command,
    typeof mailFolderReset.input,
    typeof mailFolderReset.output
>({
    ...mailFolderReset,
    access: { ...WRITE, item: accountOfFolder },
    mutates: true,
    handler: async (ctx, input) => {
        const { folder, account } = await loadFolderWithAccount(ctx, input.folderId, 'write');
        await assertMailUnlocked(ctx, account.security_tier);
        const cipher = await accountCipher(ctx, account);
        return sessionFor(ctx, account, cipher, (session) => resetFolder(session, ctx.repo, cipher, folder));
    }
});
