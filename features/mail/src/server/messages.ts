import {
    mailAttachmentDownload,
    mailAttachmentScan,
    mailMessageDelete,
    mailMessageGet,
    mailMessageList,
    mailMessageMove,
    mailMessageSearch,
    mailMessageSetFlags,
    mailSend
} from '../contracts/commands';
import type { MailAddress, MailMessageSummary } from '../contracts/domain';
import { defineSdkFeature, FeatureError } from '@deveye/types/sdk/server';

import * as mailClient from './client';
import { parseAndSanitize } from './parse';
import type { MailRepo } from './repo';
import { cacheEnvelopes, refreshFolderCounts } from './sync';
import {
    accountCipher,
    assertMailUnlocked,
    imapFor,
    loadAccount,
    loadFolderWithAccount,
    loadMessageChain,
    messageMatchesTerms,
    parseTrustedImageDomains,
    refreshCallback,
    searchTerms,
    toMessageSummaryDTO,
    WRITE
} from './_shared';

/**
 * Les messages : liste paginée d'un dossier, recherche à deux jambes, corps lu
 * en direct, drapeaux, déplacement, suppression, pièce jointe à ticket, envoi.
 *
 * Tout fonctionne sur un compte projeté d'un autre espace, sous le codec de son
 * domicile (`accountCipher`). Les réglages d'affichage (domaines d'images, mode
 * de rendu, analyse externe), eux, sont ceux de l'espace où l'on lit.
 */

export const mailMessageListFeature = defineSdkFeature<
    MailRepo,
    typeof mailMessageList.command,
    typeof mailMessageList.input,
    typeof mailMessageList.output
>({
    ...mailMessageList,
    handler: async (ctx, input) => {
        const { account } = await loadFolderWithAccount(ctx, input.folderId);
        await assertMailUnlocked(ctx, account.security_tier);
        const cipher = await accountCipher(ctx, account);
        // Le cache, et rien d'autre : la liste ne touche jamais IMAP, quel que
        // soit le palier. La fraîcheur est le travail de `mail.folderSync`, que
        // l'écran lance derrière et dont il refusionne la tête de liste.
        const rows = await ctx.repo.messages.listByFolder(input.folderId, input.cursor, input.limit);
        const messages = await Promise.all(rows.map((row) => toMessageSummaryDTO(cipher, row, account.id)));
        // A short page is the end of the folder; a full one resumes just past
        // its last row, on the same `(date, id)` key the query is ordered by.
        const last = rows[rows.length - 1];
        const nextCursor = rows.length === input.limit && last ? { date: last.date, id: last.id } : null;
        return { messages, nextCursor };
    }
});

/**
 * Ceiling on how many cached envelopes one search decrypts: everything in
 * `mail_messages` is encrypted, so a search is inherently a linear scan. The
 * response reports `scanned` so the UI can say when it hit this wall.
 */
const SEARCH_SCAN_LIMIT = 5000;

/**
 * Ceiling on envelopes pulled from IMAP for remote hits the cache doesn't hold:
 * a broad query against a large mailbox can match thousands, and the results are
 * capped for display anyway.
 */
const REMOTE_FETCH_LIMIT = 200;

export const mailMessageSearchFeature = defineSdkFeature<
    MailRepo,
    typeof mailMessageSearch.command,
    typeof mailMessageSearch.input,
    typeof mailMessageSearch.output
>({
    ...mailMessageSearch,
    handler: async (ctx, input) => {
        const { folder, account } = await loadFolderWithAccount(ctx, input.folderId);
        await assertMailUnlocked(ctx, account.security_tier);
        const cipher = await accountCipher(ctx, account);

        const terms = searchTerms(input.query);
        // Zod already rejects an empty query, but a query of pure whitespace
        // survives it and would otherwise match every single message.
        if (terms.length === 0) {
            return { messages: [], truncated: false, scanned: 0, remote: false, remoteError: null };
        }

        // Leg 1 — the cache. Always runs, always cheap, and is the whole answer
        // if the mailbox turns out to be unreachable.
        const rows = await ctx.repo.messages.listForSearch(input.folderId, SEARCH_SCAN_LIMIT);
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
            await imapFor(ctx, account, async (credentials) => {
                const refresh = refreshCallback(ctx, account, credentials, cipher);
                const uids = await mailClient.searchMessageUids(credentials, folder.imap_path, terms, refresh);

                const cached = await ctx.repo.messages.listByFolderUids(folder.id, uids);
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
                    await cacheEnvelopes(ctx.repo, cipher, folder.id, envelopes);
                    // Those rows are now part of the folder, so its unread badge
                    // and totals have to account for them.
                    await refreshFolderCounts(ctx.repo, folder);
                }
                for (const row of await ctx.repo.messages.listByFolderUids(folder.id, uids)) {
                    const summary = await toMessageSummaryDTO(cipher, row, account.id);
                    found.set(summary.id, summary);
                }
            });
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

export const mailMessageGetFeature = defineSdkFeature<
    MailRepo,
    typeof mailMessageGet.command,
    typeof mailMessageGet.input,
    typeof mailMessageGet.output
>({
    ...mailMessageGet,
    mutates: ['mailUnread'],
    handler: async (ctx, input) => {
        const { message, folder, account } = await loadMessageChain(ctx, input.messageId);
        await assertMailUnlocked(ctx, account.security_tier);
        const cipher = await accountCipher(ctx, account);
        const { credentials, refresh, raw } = await imapFor(ctx, account, async (creds) => {
            const refreshCb = refreshCallback(ctx, account, creds, cipher);
            return {
                credentials: creds,
                refresh: refreshCb,
                raw: await mailClient.fetchMessageRaw(creds, folder.imap_path, message.uid, refreshCb)
            };
        });
        const settings = await ctx.repo.settings.get(ctx.workspaceId);
        const body = await parseAndSanitize(raw, {
            allowRemoteImages: input.allowRemoteImages,
            trustedDomains: parseTrustedImageDomains(settings?.trusted_image_domains ?? null),
            preserveStyling: (settings?.body_render_mode ?? 'embedded') === 'raw'
        });

        // Opening a message marks it read, both on the server and in our cache —
        // regardless of whether the IMAP fetch itself already flipped \Seen.
        if (message.seen !== 1) {
            await mailClient.setFlags(credentials, folder.imap_path, message.uid, { seen: true }, refresh);
            await ctx.repo.messages.setFlags(message.id, { seen: true });
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

export const mailMessageSetFlagsFeature = defineSdkFeature<
    MailRepo,
    typeof mailMessageSetFlags.command,
    typeof mailMessageSetFlags.input,
    typeof mailMessageSetFlags.output
>({
    ...mailMessageSetFlags,
    access: WRITE,
    mutates: true,
    handler: async (ctx, input) => {
        const { message, folder, account } = await loadMessageChain(ctx, input.messageId, 'write');
        await assertMailUnlocked(ctx, account.security_tier);
        const cipher = await accountCipher(ctx, account);
        await imapFor(ctx, account, (credentials) =>
            mailClient.setFlags(
                credentials,
                folder.imap_path,
                message.uid,
                input.flags,
                refreshCallback(ctx, account, credentials, cipher)
            )
        );
        const row = await ctx.repo.messages.setFlags(message.id, input.flags);
        if (!row) throw new FeatureError('not_found', 'Message introuvable');
        return { message: await toMessageSummaryDTO(cipher, row, account.id) };
    }
});

export const mailMessageMoveFeature = defineSdkFeature<
    MailRepo,
    typeof mailMessageMove.command,
    typeof mailMessageMove.input,
    typeof mailMessageMove.output
>({
    ...mailMessageMove,
    access: WRITE,
    mutates: true,
    handler: async (ctx, input) => {
        const { message, folder, account } = await loadMessageChain(ctx, input.messageId, 'write');
        const target = await ctx.repo.folders.findById(input.toFolderId);
        if (!target || target.account_id !== account.id)
            throw new FeatureError('not_found', 'Dossier cible introuvable');
        await assertMailUnlocked(ctx, account.security_tier);
        const cipher = await accountCipher(ctx, account);
        const newUid = await imapFor(ctx, account, (credentials) =>
            mailClient.moveMessage(
                credentials,
                folder.imap_path,
                message.uid,
                target.imap_path,
                refreshCallback(ctx, account, credentials, cipher)
            )
        );
        await ctx.repo.messages.moveFolder(message.id, target.id, newUid);
        return { id: message.id };
    }
});

export const mailMessageDeleteFeature = defineSdkFeature<
    MailRepo,
    typeof mailMessageDelete.command,
    typeof mailMessageDelete.input,
    typeof mailMessageDelete.output
>({
    ...mailMessageDelete,
    access: WRITE,
    mutates: true,
    handler: async (ctx, input) => {
        const { message, folder, account } = await loadMessageChain(ctx, input.messageId, 'write');
        await assertMailUnlocked(ctx, account.security_tier);
        const cipher = await accountCipher(ctx, account);
        const folders = await ctx.repo.folders.listByAccount(account.id);
        const trash = folders.find((f) => f.special_use === 'trash');

        await imapFor(ctx, account, async (credentials) => {
            const refresh = refreshCallback(ctx, account, credentials, cipher);
            if (trash && trash.id !== folder.id) {
                const newUid = await mailClient.moveMessage(
                    credentials,
                    folder.imap_path,
                    message.uid,
                    trash.imap_path,
                    refresh
                );
                await ctx.repo.messages.moveFolder(message.id, trash.id, newUid);
            } else {
                await mailClient.deleteMessage(credentials, folder.imap_path, message.uid, refresh);
                await ctx.repo.messages.delete(message.id);
            }
        });
        return { id: input.messageId };
    }
});

/**
 * L'URL à ticket d'une pièce jointe : un ticket de session de deux minutes (le
 * temps que le navigateur suive le lien) qui porte le message et la pièce, rendu
 * par la route publique du module (`routes.ts`) contre les codecs de l'appelant.
 */
export const mailAttachmentDownloadFeature = defineSdkFeature<
    MailRepo,
    typeof mailAttachmentDownload.command,
    typeof mailAttachmentDownload.input,
    typeof mailAttachmentDownload.output
>({
    ...mailAttachmentDownload,
    handler: async (ctx, input) => {
        const { account } = await loadMessageChain(ctx, input.messageId);
        // La route relit la pièce chez IMAP : le refus se dit ici, où l'écran sait l'expliquer.
        await ctx.quota.assertActive('accounts', String(account.id));
        const token = await ctx.secrecy.ticket(
            { messageId: input.messageId, attachmentId: input.attachmentId },
            { ttlSeconds: 120 }
        );
        return { downloadUrl: `/api/mail/attachment?token=${encodeURIComponent(token)}` };
    }
});

export const mailAttachmentScanFeature = defineSdkFeature<
    MailRepo,
    typeof mailAttachmentScan.command,
    typeof mailAttachmentScan.input,
    typeof mailAttachmentScan.output
>({
    ...mailAttachmentScan,
    handler: async (ctx, input) => {
        await loadMessageChain(ctx, input.messageId);
        const settings = await ctx.repo.settings.get(ctx.workspaceId);
        if (!settings || settings.external_scan_enabled_default !== 1) {
            throw new FeatureError('forbidden', "L'analyse externe n'est pas activée pour ce compte");
        }
        // No scan provider is wired: this never fabricates a verdict.
        return { status: 'unknown' as const, provider: null };
    }
});

function addressLine(a: MailAddress): string {
    return a.name ? `${a.name} <${a.address}>` : a.address;
}

export const mailSendFeature = defineSdkFeature<
    MailRepo,
    typeof mailSend.command,
    typeof mailSend.input,
    typeof mailSend.output
>({
    ...mailSend,
    access: WRITE,
    mutates: true,
    handler: async (ctx, input) => {
        const account = await loadAccount(ctx, input.accountId, 'write');
        await assertMailUnlocked(ctx, account.security_tier);
        const cipher = await accountCipher(ctx, account);
        const fromEmail = (await cipher.tryDecrypt(account.email_address_enc)) ?? '';

        const result = await imapFor(ctx, account, (credentials) =>
            mailClient.sendMail(
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
            )
        );

        ctx.audit({
            action: 'mail.send',
            description: `Mail envoyé à ${input.to.map(addressLine).join(', ')}`,
            metadata: { accountId: account.id, subject: input.subject }
        });
        return { ok: true, messageId: result.messageId };
    }
});
