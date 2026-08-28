import {
    mailFolderBackfill,
    mailFolderList,
    mailFolderReorder,
    mailFolderReset,
    mailFolderSync
} from '../contracts/commands';
import { defineSdkFeature } from '@deveye/types/sdk/server';

import * as mailClient from './client';
import type { MailRepo } from './repo';
import { backfillFolder, resetFolder, syncAccountFolders, syncOneFolder } from './sync';
import {
    assertMailUnlocked,
    cipherFor,
    imapFor,
    loadAccount,
    loadFolderWithAccount,
    toFolderDTO,
    WRITE
} from './_shared';

/**
 * Les dossiers d'un compte : leur liste, leur ordre, et les trois relèves à la
 * demande (incrémentale, vers le passé, à zéro), qui passent toutes par le
 * même `sync.ts` que le service de fond, avec le vrai client IMAP.
 */

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
        const cipher = cipherFor(ctx, account.security_tier);

        // "Open" accounts are kept fresh by the background tick of `service.ts` —
        // serving the cache instantly makes switching mailboxes feel instant
        // instead of round-tripping to IMAP on every click. "Guarded" accounts
        // have no background sync, so this on-demand call is their only chance
        // to refresh (same discipline as mail.messageList).
        let rows = account.security_tier === 'guarded' ? [] : await ctx.repo.folders.listByAccount(account.id);
        if (rows.length === 0) {
            try {
                rows = await imapFor(ctx, account, (credentials) =>
                    syncAccountFolders(mailClient, ctx.repo, cipher, account, credentials)
                );
            } catch (e) {
                if (account.security_tier === 'guarded') throw e;
                // Open account, first-ever load, sync unreachable right now — fall
                // back to whatever (possibly nothing) is cached rather than failing
                // the whole switch; the background tick will fill it in shortly.
                ctx.logger.warn(
                    { accountId: account.id, err: e instanceof Error ? e.message : String(e) },
                    'mail.folderList: initial sync failed'
                );
                rows = await ctx.repo.folders.listByAccount(account.id);
            }
        }
        return { folders: await Promise.all(rows.map((row) => toFolderDTO(cipher, row))) };
    }
});

export const mailFolderReorderFeature = defineSdkFeature<
    MailRepo,
    typeof mailFolderReorder.command,
    typeof mailFolderReorder.input,
    typeof mailFolderReorder.output
>({
    ...mailFolderReorder,
    access: WRITE,
    mutates: true,
    handler: async (ctx, input) => {
        await loadAccount(ctx, input.accountId);
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
    access: WRITE,
    mutates: true,
    handler: async (ctx, input) => {
        const { folder, account } = await loadFolderWithAccount(ctx, input.folderId);
        await assertMailUnlocked(ctx, account.security_tier);
        const cipher = cipherFor(ctx, account.security_tier);
        const outcome = await imapFor(ctx, account, (credentials) =>
            syncOneFolder(mailClient, ctx.repo, cipher, account, credentials, folder)
        );
        return { ok: true, ...outcome };
    }
});

export const mailFolderBackfillFeature = defineSdkFeature<
    MailRepo,
    typeof mailFolderBackfill.command,
    typeof mailFolderBackfill.input,
    typeof mailFolderBackfill.output
>({
    ...mailFolderBackfill,
    access: WRITE,
    mutates: true,
    handler: async (ctx, input) => {
        const { folder, account } = await loadFolderWithAccount(ctx, input.folderId);
        await assertMailUnlocked(ctx, account.security_tier);
        const cipher = cipherFor(ctx, account.security_tier);
        return imapFor(ctx, account, (credentials) =>
            backfillFolder(mailClient, ctx.repo, cipher, account, credentials, folder, input.limit)
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
    access: WRITE,
    mutates: true,
    handler: async (ctx, input) => {
        const { folder, account } = await loadFolderWithAccount(ctx, input.folderId);
        await assertMailUnlocked(ctx, account.security_tier);
        const cipher = cipherFor(ctx, account.security_tier);
        return imapFor(ctx, account, (credentials) =>
            resetFolder(mailClient, ctx.repo, cipher, account, credentials, folder)
        );
    }
});
