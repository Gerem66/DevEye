import {
    MAIL_SYNC_INTERVAL_DEFAULT_MINUTES,
    mailAccountAdd,
    mailAccountCount,
    mailAccountDelete,
    mailAccountList,
    mailAccountReorder,
    mailAccountSetEnabled,
    mailAccountSetProfile,
    mailAccountTestConnection,
    mailAccountUpdate,
    mailAttachmentDownload,
    mailAttachmentScan,
    mailFolderBackfill,
    mailFolderList,
    mailFolderReorder,
    mailFolderReset,
    mailFolderSync,
    mailGetSettings,
    mailMessageDelete,
    mailMessageGet,
    mailMessageList,
    mailMessageMove,
    mailMessageSearch,
    mailMessageSetFlags,
    mailOAuthStart,
    mailSend,
    mailSetSettings
} from 'deveye-types';
import type {
    MailAccountRow,
    MailAddress,
    MailFolderRow,
    MailMessageRow,
    MailMessageSummary,
    MailSecurityTier
} from 'deveye-types';

import * as mailClient from '@/Services/MailAccountClient';
import type { MailCredentials, MailPasswordCredentials } from '@/Services/MailAccountClient';
import { buildAuthorizationUrl, isOAuthConfigured } from '@/Services/MailOAuth';
import type { Cipher } from '@/Services/SecureStore';
import { signMailAttachmentToken, signMailOAuthState } from '@/auth/jwt';
import { parseAndSanitize } from '@/mail/parseMessage';
import { defineFeature, FeatureError, type FeatureContext, type FeatureDefinition } from '../_define';
import {
    backfillFolder,
    cacheEnvelopes,
    refreshFolderCounts,
    resetFolder,
    syncAccountFolders,
    syncOneFolder
} from './_sync';
import {
    assertMailUnlocked,
    cipherFor,
    decryptCredentials,
    encryptCredentials,
    messageMatchesTerms,
    parseTrustedImageDomains,
    persistRefreshedToken,
    reencryptAccountTree,
    searchTerms,
    toAccountDTO,
    toFolderDTO,
    toMessageSummaryDTO,
    toSettingsDTO
} from './_shared';

/** Load a caller-owned account row, or throw `not_found`. */
async function loadAccount(ctx: FeatureContext, id: number): Promise<MailAccountRow> {
    const row = await ctx.db.mailAccounts.findById(id, ctx.workspaceId);
    if (!row) throw new FeatureError('not_found', 'Compte mail introuvable');
    return row;
}

/** Load a folder and its owning account, checking the caller owns it. */
async function loadFolderWithAccount(
    ctx: FeatureContext,
    folderId: number
): Promise<{ folder: MailFolderRow; account: MailAccountRow }> {
    const folder = await ctx.db.mailFolders.findById(folderId);
    if (!folder) throw new FeatureError('not_found', 'Dossier introuvable');
    const account = await loadAccount(ctx, folder.account_id);
    return { folder, account };
}

/** Load a message with its folder + owning account, checking ownership. */
async function loadMessageChain(
    ctx: FeatureContext,
    messageId: number
): Promise<{ message: MailMessageRow; folder: MailFolderRow; account: MailAccountRow }> {
    const message = await ctx.db.mailMessages.findById(messageId);
    if (!message) throw new FeatureError('not_found', 'Message introuvable');
    const { folder, account } = await loadFolderWithAccount(ctx, message.folder_id);
    return { message, folder, account };
}

/** Persist a refreshed OAuth token back onto the account, re-encrypted with the same cipher. */
function refreshCallback(
    ctx: FeatureContext,
    account: MailAccountRow,
    credentials: MailCredentials,
    cipher = cipherFor(ctx, account.security_tier)
) {
    return persistRefreshedToken(ctx.db, account.id, credentials, cipher);
}

type ServerEndpoint = MailPasswordCredentials['imap'];

/** Overlay an edited endpoint on the stored one: blank username/password keep what's there. */
function mergeEndpoint(next: ServerEndpoint, stored: ServerEndpoint | undefined): ServerEndpoint {
    return {
        host: next.host,
        port: next.port,
        username: next.username || (stored?.username ?? ''),
        password: next.password || (stored?.password ?? '')
    };
}

async function credentialsFor(ctx: FeatureContext, account: MailAccountRow): Promise<MailCredentials> {
    return decryptCredentials(cipherFor(ctx, account.security_tier), account.credentials_enc);
}

/**
 * Finish a tier switch: the caller has already rewritten the account row under
 * `to`, this carries over everything hanging off it (cached folder names and
 * envelopes, plus the last sync error) so nothing is left readable only by the
 * cipher the account no longer uses.
 */
async function rekeyTier(
    ctx: FeatureContext,
    previous: MailAccountRow,
    nextTier: MailSecurityTier,
    to: Cipher
): Promise<void> {
    const from = cipherFor(ctx, previous.security_tier);
    if (previous.last_sync_error_enc) {
        const error = await from.tryDecrypt(previous.last_sync_error_enc);
        await ctx.db.mailAccounts.updateSyncError(previous.id, error === null ? null : await to.encrypt(error));
    }
    await reencryptAccountTree(ctx.db, from, to, previous.id);
    ctx.logger.info(
        { accountId: previous.id, from: previous.security_tier, to: nextTier },
        'Mail account tier changed'
    );
}

export const mailAccountListFeature: FeatureDefinition<
    typeof mailAccountList.command,
    typeof mailAccountList.input,
    typeof mailAccountList.output
> = defineFeature({
    ...mailAccountList,
    handler: async (ctx) => {
        const rows = await ctx.db.mailAccounts.listByWorkspace(ctx.workspaceId);
        const accounts = await Promise.all(rows.map((row) => toAccountDTO(cipherFor(ctx, row.security_tier), row)));
        return { accounts };
    }
});

export const mailAccountCountFeature: FeatureDefinition<
    typeof mailAccountCount.command,
    typeof mailAccountCount.input,
    typeof mailAccountCount.output
> = defineFeature({
    ...mailAccountCount,
    handler: async (ctx) => ({ count: await ctx.db.mailAccounts.count(ctx.workspaceId) })
});

export const mailAccountAddFeature: FeatureDefinition<
    typeof mailAccountAdd.command,
    typeof mailAccountAdd.input,
    typeof mailAccountAdd.output
> = defineFeature({
    ...mailAccountAdd,
    handler: async (ctx, input) => {
        await assertMailUnlocked(ctx, input.draft.securityTier);
        const cipher = cipherFor(ctx, input.draft.securityTier);
        const credentials: MailCredentials = {
            kind: 'password',
            imap: input.draft.imap,
            smtp: input.draft.smtp,
            proxy: input.draft.proxy
        };
        const row = await ctx.db.mailAccounts.create({
            userId: ctx.userId,
            workspaceId: ctx.workspaceId,
            displayNameEnc: await cipher.encrypt(input.draft.displayName),
            emailAddressEnc: await cipher.encrypt(input.draft.emailAddress),
            securityTier: input.draft.securityTier,
            authMethod: 'password',
            credentialsEnc: await encryptCredentials(cipher, credentials),
            enabled: true,
            syncIntervalSeconds: MAIL_SYNC_INTERVAL_DEFAULT_MINUTES * 60
        });
        ctx.audit({
            action: 'mail.accountAdd',
            description: `Compte mail ajouté : « ${input.draft.displayName} »`,
            metadata: { accountId: row.id }
        });
        return { account: await toAccountDTO(cipher, row) };
    }
});

export const mailAccountUpdateFeature: FeatureDefinition<
    typeof mailAccountUpdate.command,
    typeof mailAccountUpdate.input,
    typeof mailAccountUpdate.output
> = defineFeature({
    ...mailAccountUpdate,
    handler: async (ctx, input) => {
        const existing = await loadAccount(ctx, input.id);
        if (existing.auth_method !== 'password') {
            throw new FeatureError(
                'validation',
                'Un compte connecté par OAuth ne se modifie pas ainsi : supprimez-le puis reconnectez-le'
            );
        }
        await assertMailUnlocked(ctx, existing.security_tier);
        await assertMailUnlocked(ctx, input.draft.securityTier);
        const cipher = cipherFor(ctx, input.draft.securityTier);

        // The edit form can't prefill secrets (the DTO never serves one back),
        // so a blank field means "keep it" rather than "clear it" — otherwise
        // renaming a mailbox would silently break its credentials.
        const stored = await credentialsFor(ctx, existing);
        const kept = stored.kind === 'password' ? stored : null;
        const credentials: MailCredentials = {
            kind: 'password',
            imap: mergeEndpoint(input.draft.imap, kept?.imap),
            smtp: mergeEndpoint(input.draft.smtp, kept?.smtp),
            proxy: input.draft.proxy === undefined ? (kept?.proxy ?? null) : input.draft.proxy
        };
        for (const [label, endpoint] of [
            ['IMAP', credentials.imap],
            ['SMTP', credentials.smtp]
        ] as const) {
            if (!endpoint.username || !endpoint.password) {
                throw new FeatureError('validation', `Identifiant et mot de passe ${label} requis`);
            }
        }
        const row = await ctx.db.mailAccounts.update(input.id, ctx.workspaceId, {
            displayNameEnc: await cipher.encrypt(input.draft.displayName),
            emailAddressEnc: await cipher.encrypt(input.draft.emailAddress),
            securityTier: input.draft.securityTier,
            authMethod: 'password',
            credentialsEnc: await encryptCredentials(cipher, credentials),
            enabled: existing.enabled === 1,
            // Owned by the account's own options panel, not by this form.
            syncIntervalSeconds: existing.sync_interval_seconds
        });
        if (!row) throw new FeatureError('not_found', 'Compte mail introuvable');
        if (existing.security_tier !== input.draft.securityTier) {
            await rekeyTier(ctx, existing, input.draft.securityTier, cipher);
        }
        ctx.audit({
            action: 'mail.accountUpdate',
            description: `Compte mail modifié : « ${input.draft.displayName} »`,
            metadata: { accountId: row.id }
        });
        return { account: await toAccountDTO(cipher, row) };
    }
});

export const mailAccountSetProfileFeature: FeatureDefinition<
    typeof mailAccountSetProfile.command,
    typeof mailAccountSetProfile.input,
    typeof mailAccountSetProfile.output
> = defineFeature({
    ...mailAccountSetProfile,
    handler: async (ctx, input) => {
        const existing = await loadAccount(ctx, input.id);
        // Both ends of the move have to be reachable: reading what's there now,
        // and writing it back under the tier the user is switching to.
        await assertMailUnlocked(ctx, existing.security_tier);
        await assertMailUnlocked(ctx, input.securityTier);
        const from = cipherFor(ctx, existing.security_tier);
        const to = cipherFor(ctx, input.securityTier);

        const credentials = await decryptCredentials(from, existing.credentials_enc);
        // Absent means "leave the proxy alone" — the DTO never echoes proxy
        // credentials back, so the client has nothing to resubmit (see the
        // command's own doc); only an explicit null removes it.
        if (input.proxy !== undefined) credentials.proxy = input.proxy;
        const emailAddress = (await from.tryDecrypt(existing.email_address_enc)) ?? '';

        const row = await ctx.db.mailAccounts.update(input.id, ctx.workspaceId, {
            displayNameEnc: await to.encrypt(input.displayName),
            emailAddressEnc: await to.encrypt(emailAddress),
            securityTier: input.securityTier,
            authMethod: existing.auth_method,
            credentialsEnc: await encryptCredentials(to, credentials),
            enabled: existing.enabled === 1,
            syncIntervalSeconds: input.syncIntervalMinutes * 60
        });
        if (!row) throw new FeatureError('not_found', 'Compte mail introuvable');
        if (existing.security_tier !== input.securityTier) {
            await rekeyTier(ctx, existing, input.securityTier, to);
        }

        ctx.audit({
            action: 'mail.accountSetProfile',
            description: `Compte mail modifié : « ${input.displayName} »`,
            metadata: { accountId: row.id, securityTier: input.securityTier }
        });
        return { account: await toAccountDTO(to, row) };
    }
});

export const mailAccountDeleteFeature: FeatureDefinition<
    typeof mailAccountDelete.command,
    typeof mailAccountDelete.input,
    typeof mailAccountDelete.output
> = defineFeature({
    ...mailAccountDelete,
    handler: async (ctx, input) => {
        await loadAccount(ctx, input.id);
        await ctx.db.mailAccounts.delete(input.id, ctx.workspaceId);
        ctx.audit({
            action: 'mail.accountDelete',
            level: 'warning',
            description: 'Compte mail supprimé',
            metadata: { accountId: input.id }
        });
        return { id: input.id };
    }
});

export const mailAccountReorderFeature: FeatureDefinition<
    typeof mailAccountReorder.command,
    typeof mailAccountReorder.input,
    typeof mailAccountReorder.output
> = defineFeature({
    ...mailAccountReorder,
    handler: async (ctx, input) => {
        await ctx.db.mailAccounts.reorder(ctx.workspaceId, input.ids);
        return { ids: input.ids };
    }
});

export const mailAccountSetEnabledFeature: FeatureDefinition<
    typeof mailAccountSetEnabled.command,
    typeof mailAccountSetEnabled.input,
    typeof mailAccountSetEnabled.output
> = defineFeature({
    ...mailAccountSetEnabled,
    handler: async (ctx, input) => {
        const row = await ctx.db.mailAccounts.setEnabled(input.id, ctx.workspaceId, input.enabled);
        if (!row) throw new FeatureError('not_found', 'Compte mail introuvable');
        return { account: await toAccountDTO(cipherFor(ctx, row.security_tier), row) };
    }
});

export const mailAccountTestConnectionFeature: FeatureDefinition<
    typeof mailAccountTestConnection.command,
    typeof mailAccountTestConnection.input,
    typeof mailAccountTestConnection.output
> = defineFeature({
    ...mailAccountTestConnection,
    handler: async (ctx, input) => {
        if (input.draft) {
            const credentials: MailCredentials = {
                kind: 'password',
                imap: input.draft.imap,
                smtp: input.draft.smtp,
                proxy: input.draft.proxy
            };
            return mailClient.testConnection(credentials);
        }
        // The command's own `.refine` guarantees exactly one of `id`/`draft`,
        // so reaching here means `id` is set — but narrow it rather than assert.
        if (input.id === undefined) throw new FeatureError('validation', 'Fournir soit id, soit draft');
        const account = await loadAccount(ctx, input.id);
        await assertMailUnlocked(ctx, account.security_tier);
        const credentials = await credentialsFor(ctx, account);
        return mailClient.testConnection(credentials, refreshCallback(ctx, account, credentials));
    }
});

export const mailOAuthStartFeature: FeatureDefinition<
    typeof mailOAuthStart.command,
    typeof mailOAuthStart.input,
    typeof mailOAuthStart.output
> = defineFeature({
    ...mailOAuthStart,
    handler: async (ctx, input) => {
        if (!isOAuthConfigured(input.provider)) {
            throw new FeatureError('validation', `OAuth ${input.provider} n'est pas configuré sur ce serveur`);
        }
        const state = await signMailOAuthState({
            userId: ctx.userId,
            workspaceId: ctx.workspaceId,
            sessionId: ctx.sessionId,
            provider: input.provider,
            securityTier: input.securityTier
        });
        return { authUrl: buildAuthorizationUrl(input.provider, state) };
    }
});

export const mailFolderListFeature: FeatureDefinition<
    typeof mailFolderList.command,
    typeof mailFolderList.input,
    typeof mailFolderList.output
> = defineFeature({
    ...mailFolderList,
    handler: async (ctx, input) => {
        const account = await loadAccount(ctx, input.accountId);
        await assertMailUnlocked(ctx, account.security_tier);
        const cipher = cipherFor(ctx, account.security_tier);

        // "Open" accounts are kept fresh by MailSyncService's background tick —
        // serving the cache instantly makes switching mailboxes feel instant
        // instead of round-tripping to IMAP on every click. "Guarded" accounts
        // have no background sync, so this on-demand call is their only chance
        // to refresh (same discipline as mail.messageList).
        let rows = account.security_tier === 'guarded' ? [] : await ctx.db.mailFolders.listByAccount(account.id);
        if (rows.length === 0) {
            const credentials = await credentialsFor(ctx, account);
            try {
                rows = await syncAccountFolders(ctx.db, cipher, account, credentials);
            } catch (e) {
                if (account.security_tier === 'guarded') throw e;
                // Open account, first-ever load, sync unreachable right now — fall
                // back to whatever (possibly nothing) is cached rather than failing
                // the whole switch; the background tick will fill it in shortly.
                ctx.logger.warn(
                    { accountId: account.id, err: e instanceof Error ? e.message : String(e) },
                    'mail.folderList: initial sync failed'
                );
                rows = await ctx.db.mailFolders.listByAccount(account.id);
            }
        }
        return { folders: await Promise.all(rows.map((row) => toFolderDTO(cipher, row))) };
    }
});

export const mailFolderReorderFeature: FeatureDefinition<
    typeof mailFolderReorder.command,
    typeof mailFolderReorder.input,
    typeof mailFolderReorder.output
> = defineFeature({
    ...mailFolderReorder,
    handler: async (ctx, input) => {
        await loadAccount(ctx, input.accountId);
        await ctx.db.mailFolders.reorder(input.accountId, input.ids);
        return { ids: input.ids };
    }
});

export const mailFolderSyncFeature: FeatureDefinition<
    typeof mailFolderSync.command,
    typeof mailFolderSync.input,
    typeof mailFolderSync.output
> = defineFeature({
    ...mailFolderSync,
    handler: async (ctx, input) => {
        const { folder, account } = await loadFolderWithAccount(ctx, input.folderId);
        await assertMailUnlocked(ctx, account.security_tier);
        const cipher = cipherFor(ctx, account.security_tier);
        const credentials = await credentialsFor(ctx, account);
        const { newCount } = await syncOneFolder(ctx.db, cipher, account, credentials, folder);
        return { ok: true, newCount };
    }
});

export const mailFolderBackfillFeature: FeatureDefinition<
    typeof mailFolderBackfill.command,
    typeof mailFolderBackfill.input,
    typeof mailFolderBackfill.output
> = defineFeature({
    ...mailFolderBackfill,
    handler: async (ctx, input) => {
        const { folder, account } = await loadFolderWithAccount(ctx, input.folderId);
        await assertMailUnlocked(ctx, account.security_tier);
        const cipher = cipherFor(ctx, account.security_tier);
        const credentials = await credentialsFor(ctx, account);
        return backfillFolder(ctx.db, cipher, account, credentials, folder, input.limit);
    }
});

export const mailFolderResetFeature: FeatureDefinition<
    typeof mailFolderReset.command,
    typeof mailFolderReset.input,
    typeof mailFolderReset.output
> = defineFeature({
    ...mailFolderReset,
    handler: async (ctx, input) => {
        const { folder, account } = await loadFolderWithAccount(ctx, input.folderId);
        await assertMailUnlocked(ctx, account.security_tier);
        const cipher = cipherFor(ctx, account.security_tier);
        const credentials = await credentialsFor(ctx, account);
        return resetFolder(ctx.db, cipher, account, credentials, folder);
    }
});

export const mailMessageListFeature: FeatureDefinition<
    typeof mailMessageList.command,
    typeof mailMessageList.input,
    typeof mailMessageList.output
> = defineFeature({
    ...mailMessageList,
    handler: async (ctx, input) => {
        const { folder, account } = await loadFolderWithAccount(ctx, input.folderId);
        await assertMailUnlocked(ctx, account.security_tier);
        const cipher = cipherFor(ctx, account.security_tier);
        // "Guarded" accounts have no background sync — this is their only chance
        // to refresh, so the list is synced on every open. Best-effort: a sync
        // failure (offline, bad creds) still serves whatever is already cached.
        if (account.security_tier === 'guarded') {
            const credentials = await credentialsFor(ctx, account);
            try {
                await syncOneFolder(ctx.db, cipher, account, credentials, folder);
            } catch (e) {
                ctx.logger.warn(
                    { folderId: folder.id, err: e instanceof Error ? e.message : String(e) },
                    'mail.messageList: on-demand sync failed'
                );
            }
        }
        const rows = await ctx.db.mailMessages.listByFolder(input.folderId, input.cursor, input.limit);
        const messages = await Promise.all(rows.map((row) => toMessageSummaryDTO(cipher, row, account.id)));
        // A short page is the end of the folder; a full one resumes just past
        // its last row, on the same `(date, id)` key the query is ordered by.
        const last = rows[rows.length - 1];
        const nextCursor = rows.length === input.limit && last ? { date: last.date, id: last.id } : null;
        return { messages, nextCursor };
    }
});

/**
 * Ceiling on how many cached envelopes one search decrypts. Everything in
 * `mail_messages` is encrypted, so a search is inherently a linear scan — this
 * keeps its cost bounded no matter how deeply a folder has been backfilled.
 * The response reports `scanned` so the UI can say when it hit this wall.
 */
const SEARCH_SCAN_LIMIT = 5000;

/**
 * Ceiling on envelopes pulled from IMAP for remote hits the cache doesn't hold.
 * A broad query against a large mailbox can match thousands; fetching all of
 * them would turn a keystroke into a very long round trip, and the results are
 * capped for display anyway.
 */
const REMOTE_FETCH_LIMIT = 200;

export const mailMessageSearchFeature: FeatureDefinition<
    typeof mailMessageSearch.command,
    typeof mailMessageSearch.input,
    typeof mailMessageSearch.output
> = defineFeature({
    ...mailMessageSearch,
    handler: async (ctx, input) => {
        const { folder, account } = await loadFolderWithAccount(ctx, input.folderId);
        await assertMailUnlocked(ctx, account.security_tier);
        const cipher = cipherFor(ctx, account.security_tier);

        const terms = searchTerms(input.query);
        // Zod already rejects an empty query, but a query of pure whitespace
        // survives it and would otherwise match every single message.
        if (terms.length === 0) {
            return { messages: [], truncated: false, scanned: 0, remote: false, remoteError: null };
        }

        // Leg 1 — the cache. Always runs, always cheap, and is the whole answer
        // if the mailbox turns out to be unreachable.
        const rows = await ctx.db.mailMessages.listForSearch(input.folderId, SEARCH_SCAN_LIMIT);
        const found = new Map<number, MailMessageSummary>();
        for (const row of rows) {
            const summary = await toMessageSummaryDTO(cipher, row, account.id);
            if (messageMatchesTerms(summary, terms)) found.set(summary.id, summary);
        }

        // Leg 2 — the mail server, which can see bodies and messages that were
        // never synced. Best-effort by design: an unreachable mailbox degrades
        // the search to its cached half rather than failing it.
        let remote = false;
        let remoteError: string | null = null;
        try {
            const credentials = await credentialsFor(ctx, account);
            const refresh = refreshCallback(ctx, account, credentials, cipher);
            const uids = await mailClient.searchMessageUids(credentials, folder.imap_path, terms, refresh);

            const cached = await ctx.db.mailMessages.listByFolderUids(folder.id, uids);
            const known = new Set(cached.map((r) => r.uid));
            const missing = uids.filter((uid) => !known.has(uid)).slice(0, REMOTE_FETCH_LIMIT);
            if (missing.length > 0) {
                // Caching them is what makes a remote hit usable: every later
                // action (open, flag, delete) addresses a message by its row id.
                const envelopes = await mailClient.fetchEnvelopesByUids(
                    credentials,
                    folder.imap_path,
                    missing,
                    refresh
                );
                await cacheEnvelopes(ctx.db, cipher, folder.id, envelopes);
                // Those rows are now part of the folder, so its unread badge
                // and totals have to account for them.
                await refreshFolderCounts(ctx.db, folder);
            }
            for (const row of await ctx.db.mailMessages.listByFolderUids(folder.id, uids)) {
                const summary = await toMessageSummaryDTO(cipher, row, account.id);
                found.set(summary.id, summary);
            }
            remote = true;
        } catch (e) {
            remoteError = e instanceof Error ? e.message : String(e);
            ctx.logger.warn({ folderId: folder.id, err: remoteError }, 'mail.messageSearch: IMAP leg failed');
        }

        // Newest first, matching the folder listing's own order.
        const all = [...found.values()].sort((a, b) => b.date - a.date || b.id - a.id);
        return {
            messages: all.slice(0, input.limit),
            truncated: all.length > input.limit,
            scanned: rows.length,
            remote,
            remoteError
        };
    }
});

export const mailMessageGetFeature: FeatureDefinition<
    typeof mailMessageGet.command,
    typeof mailMessageGet.input,
    typeof mailMessageGet.output
> = defineFeature({
    ...mailMessageGet,
    handler: async (ctx, input) => {
        const { message, folder, account } = await loadMessageChain(ctx, input.messageId);
        await assertMailUnlocked(ctx, account.security_tier);
        const cipher = cipherFor(ctx, account.security_tier);
        const credentials = await credentialsFor(ctx, account);
        const refresh = refreshCallback(ctx, account, credentials, cipher);

        const raw = await mailClient.fetchMessageRaw(credentials, folder.imap_path, message.uid, refresh);
        const settings = await ctx.db.mailSettings.get(ctx.workspaceId);
        const body = await parseAndSanitize(raw, {
            allowRemoteImages: input.allowRemoteImages,
            trustedDomains: parseTrustedImageDomains(settings?.trusted_image_domains ?? null),
            preserveStyling: (settings?.body_render_mode ?? 'embedded') === 'raw'
        });

        // Opening a message marks it read, both on the server and in our cache —
        // regardless of whether the IMAP fetch itself already flipped \Seen.
        if (message.seen !== 1) {
            await mailClient.setFlags(credentials, folder.imap_path, message.uid, { seen: true }, refresh);
            await ctx.db.mailMessages.setFlags(message.id, { seen: true });
        }

        const summary = await toMessageSummaryDTO(cipher, { ...message, seen: 1 }, account.id);
        return {
            message: {
                ...summary,
                bodyHtml: body.bodyHtml,
                bodyText: body.bodyText,
                attachments: body.attachments,
                remoteImagesBlocked: body.remoteImagesBlocked,
                blockedImageSources: body.blockedImageSources,
                suspiciousLinks: body.suspiciousLinks,
                headers: body.headers,
                sizeBytes: raw.length,
                folderPath: folder.imap_path
            }
        };
    }
});

export const mailMessageSetFlagsFeature: FeatureDefinition<
    typeof mailMessageSetFlags.command,
    typeof mailMessageSetFlags.input,
    typeof mailMessageSetFlags.output
> = defineFeature({
    ...mailMessageSetFlags,
    handler: async (ctx, input) => {
        const { message, folder, account } = await loadMessageChain(ctx, input.messageId);
        await assertMailUnlocked(ctx, account.security_tier);
        const cipher = cipherFor(ctx, account.security_tier);
        const credentials = await credentialsFor(ctx, account);
        await mailClient.setFlags(
            credentials,
            folder.imap_path,
            message.uid,
            input.flags,
            refreshCallback(ctx, account, credentials, cipher)
        );
        const row = await ctx.db.mailMessages.setFlags(message.id, input.flags);
        if (!row) throw new FeatureError('not_found', 'Message introuvable');
        return { message: await toMessageSummaryDTO(cipher, row, account.id) };
    }
});

export const mailMessageMoveFeature: FeatureDefinition<
    typeof mailMessageMove.command,
    typeof mailMessageMove.input,
    typeof mailMessageMove.output
> = defineFeature({
    ...mailMessageMove,
    handler: async (ctx, input) => {
        const { message, folder, account } = await loadMessageChain(ctx, input.messageId);
        const target = await ctx.db.mailFolders.findById(input.toFolderId);
        if (!target || target.account_id !== account.id)
            throw new FeatureError('not_found', 'Dossier cible introuvable');
        await assertMailUnlocked(ctx, account.security_tier);
        const cipher = cipherFor(ctx, account.security_tier);
        const credentials = await credentialsFor(ctx, account);
        const newUid = await mailClient.moveMessage(
            credentials,
            folder.imap_path,
            message.uid,
            target.imap_path,
            refreshCallback(ctx, account, credentials, cipher)
        );
        await ctx.db.mailMessages.moveFolder(message.id, target.id, newUid);
        return { id: message.id };
    }
});

export const mailMessageDeleteFeature: FeatureDefinition<
    typeof mailMessageDelete.command,
    typeof mailMessageDelete.input,
    typeof mailMessageDelete.output
> = defineFeature({
    ...mailMessageDelete,
    handler: async (ctx, input) => {
        const { message, folder, account } = await loadMessageChain(ctx, input.messageId);
        await assertMailUnlocked(ctx, account.security_tier);
        const cipher = cipherFor(ctx, account.security_tier);
        const credentials = await credentialsFor(ctx, account);
        const refresh = refreshCallback(ctx, account, credentials, cipher);

        const folders = await ctx.db.mailFolders.listByAccount(account.id);
        const trash = folders.find((f) => f.special_use === 'trash');

        if (trash && trash.id !== folder.id) {
            const newUid = await mailClient.moveMessage(
                credentials,
                folder.imap_path,
                message.uid,
                trash.imap_path,
                refresh
            );
            await ctx.db.mailMessages.moveFolder(message.id, trash.id, newUid);
        } else {
            await mailClient.deleteMessage(credentials, folder.imap_path, message.uid, refresh);
            await ctx.db.mailMessages.delete(message.id);
        }
        return { id: input.messageId };
    }
});

export const mailAttachmentDownloadFeature: FeatureDefinition<
    typeof mailAttachmentDownload.command,
    typeof mailAttachmentDownload.input,
    typeof mailAttachmentDownload.output
> = defineFeature({
    ...mailAttachmentDownload,
    handler: async (ctx, input) => {
        await loadMessageChain(ctx, input.messageId);
        const token = await signMailAttachmentToken({
            messageId: input.messageId,
            attachmentId: input.attachmentId,
            userId: ctx.userId,
            sessionId: ctx.sessionId
        });
        return { downloadUrl: `/api/mail/attachment?token=${encodeURIComponent(token)}` };
    }
});

export const mailAttachmentScanFeature: FeatureDefinition<
    typeof mailAttachmentScan.command,
    typeof mailAttachmentScan.input,
    typeof mailAttachmentScan.output
> = defineFeature({
    ...mailAttachmentScan,
    handler: async (ctx, input) => {
        await loadMessageChain(ctx, input.messageId);
        const settings = await ctx.db.mailSettings.get(ctx.workspaceId);
        if (!settings || settings.external_scan_enabled_default !== 1) {
            throw new FeatureError('forbidden', "L'analyse externe n'est pas activée pour ce compte");
        }
        // No concrete scan provider wired yet (opt-in placeholder — see plan's
        // V2 note on ExternalScanProvider). Never fabricates a verdict.
        return { status: 'unknown' as const, provider: null };
    }
});

function addressLine(a: MailAddress): string {
    return a.name ? `${a.name} <${a.address}>` : a.address;
}

export const mailSendFeature: FeatureDefinition<
    typeof mailSend.command,
    typeof mailSend.input,
    typeof mailSend.output
> = defineFeature({
    ...mailSend,
    handler: async (ctx, input) => {
        const account = await loadAccount(ctx, input.accountId);
        await assertMailUnlocked(ctx, account.security_tier);
        const cipher = cipherFor(ctx, account.security_tier);
        const credentials = await credentialsFor(ctx, account);
        const fromEmail = (await cipher.tryDecrypt(account.email_address_enc)) ?? '';

        const result = await mailClient.sendMail(
            credentials,
            {
                from: fromEmail,
                to: input.to,
                cc: input.cc,
                bcc: input.bcc,
                subject: input.subject,
                text: input.bodyText,
                html: input.bodyHtml,
                attachments: input.attachments?.map((a) => ({
                    filename: a.filename,
                    contentType: a.mimeType,
                    content: Buffer.from(a.contentBase64, 'base64')
                })),
                inReplyTo: input.inReplyTo
            },
            refreshCallback(ctx, account, credentials, cipher)
        );

        ctx.audit({
            action: 'mail.send',
            description: `Mail envoyé à ${input.to.map(addressLine).join(', ')}`,
            metadata: { accountId: account.id, subject: input.subject }
        });
        return { ok: true, messageId: result.messageId };
    }
});

export const mailGetSettingsFeature: FeatureDefinition<
    typeof mailGetSettings.command,
    typeof mailGetSettings.input,
    typeof mailGetSettings.output
> = defineFeature({
    ...mailGetSettings,
    handler: async (ctx) => {
        const row = await ctx.db.mailSettings.get(ctx.workspaceId);
        return { settings: toSettingsDTO(row) };
    }
});

export const mailSetSettingsFeature: FeatureDefinition<
    typeof mailSetSettings.command,
    typeof mailSetSettings.input,
    typeof mailSetSettings.output
> = defineFeature({
    ...mailSetSettings,
    handler: async (ctx, input) => {
        const row = await ctx.db.mailSettings.set(ctx.workspaceId, {
            externalScanEnabledDefault: input.externalScanEnabledDefault,
            trustedImageDomains: input.trustedImageDomains,
            bodyRenderMode: input.bodyRenderMode
        });
        ctx.audit({
            action: 'mail.setSettings',
            description: 'Paramètres Mail modifiés',
            metadata: { externalScan: input.externalScanEnabledDefault, bodyRenderMode: input.bodyRenderMode }
        });
        return { settings: toSettingsDTO(row) };
    }
});

/** Same order as `mailCommands` in the contract, so the two lists diff against each other. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const mailFeatures: FeatureDefinition<string, any, any>[] = [
    mailAccountListFeature,
    mailAccountCountFeature,
    mailAccountAddFeature,
    mailAccountUpdateFeature,
    mailAccountSetProfileFeature,
    mailAccountDeleteFeature,
    mailAccountReorderFeature,
    mailAccountSetEnabledFeature,
    mailAccountTestConnectionFeature,
    mailOAuthStartFeature,
    mailFolderListFeature,
    mailFolderReorderFeature,
    mailFolderSyncFeature,
    mailFolderBackfillFeature,
    mailFolderResetFeature,
    mailMessageListFeature,
    mailMessageSearchFeature,
    mailMessageGetFeature,
    mailMessageSetFlagsFeature,
    mailMessageMoveFeature,
    mailMessageDeleteFeature,
    mailAttachmentDownloadFeature,
    mailAttachmentScanFeature,
    mailSendFeature,
    mailGetSettingsFeature,
    mailSetSettingsFeature
];
