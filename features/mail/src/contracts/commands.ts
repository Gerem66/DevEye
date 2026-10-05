import { z } from 'zod';
import {
    MAIL_DISPLAY_NAME_MAX_LENGTH,
    MAIL_SEARCH_QUERY_MAX_LENGTH,
    MAIL_SUBJECT_MAX_LENGTH,
    MAIL_SYNC_INTERVAL_MAX_MINUTES,
    MAIL_SYNC_INTERVAL_MIN_MINUTES,
    mailAccountDraftSchema,
    mailAccountEditSchema,
    mailAccountSchema,
    mailAddressSchema,
    mailFolderSchema,
    mailMessageSchema,
    mailMessageCursorSchema,
    mailMessageSummarySchema,
    mailOAuthProviderSchema,
    mailProxySchema,
    mailSecurityTierSchema,
    mailSettingsSchema
} from './domain';

const accountId = z.number().int().positive();
const folderId = z.number().int().positive();
const messageId = z.number().int().positive();

export const mailAccountList = {
    command: 'mail.accountList' as const,
    input: z.object({}),
    output: z.object({ accounts: z.array(mailAccountSchema) })
};

/**
 * Clear metadata only (row count across the user's accounts), so it never
 * requires an unlocked session and a summary widget always renders a number.
 */
export const mailAccountCount = {
    command: 'mail.accountCount' as const,
    input: z.object({}),
    output: z.object({ count: z.number().int().nonnegative() })
};

/** Password-auth only — OAuth accounts are created via `mail.oauthStart`. */
export const mailAccountAdd = {
    command: 'mail.accountAdd' as const,
    input: z.object({ draft: mailAccountDraftSchema }),
    output: z.object({ account: mailAccountSchema })
};

/**
 * Replaces a password-auth account's server configuration. Blank credentials
 * and an omitted proxy keep whatever is stored — see `mailAccountEditSchema`.
 */
export const mailAccountUpdate = {
    command: 'mail.accountUpdate' as const,
    input: z.object({ id: accountId, draft: mailAccountEditSchema }),
    output: z.object({ account: mailAccountSchema })
};

/**
 * The part of an account that exists whatever its auth method: label, storage
 * tier, optional proxy. Separate from `mailAccountUpdate`, which is inseparable
 * from a full set of server credentials an OAuth mailbox doesn't have to give,
 * so this is the only edit path for an OAuth account.
 *
 * `proxy` omitted means "leave it as it is": the account DTO never echoes proxy
 * credentials back, so an absent field must not be read as "remove it". `null`
 * removes it.
 */
export const mailAccountSetProfile = {
    command: 'mail.accountSetProfile' as const,
    input: z.object({
        id: accountId,
        displayName: z.string().min(1).max(MAIL_DISPLAY_NAME_MAX_LENGTH),
        securityTier: mailSecurityTierSchema,
        syncIntervalMinutes: z.number().int().min(MAIL_SYNC_INTERVAL_MIN_MINUTES).max(MAIL_SYNC_INTERVAL_MAX_MINUTES),
        proxy: mailProxySchema.nullable().optional()
    }),
    output: z.object({ account: mailAccountSchema })
};

export const mailAccountDelete = {
    command: 'mail.accountDelete' as const,
    input: z.object({ id: accountId }),
    output: z.object({ id: accountId })
};

/** `ids` is the complete, final order. */
export const mailAccountReorder = {
    command: 'mail.accountReorder' as const,
    input: z.object({ ids: z.array(accountId).min(1) }),
    output: z.object({ ids: z.array(accountId) })
};

/** Pause/resume background sync without deleting the account. */
export const mailAccountSetEnabled = {
    command: 'mail.accountSetEnabled' as const,
    input: z.object({ id: accountId, enabled: z.boolean() }),
    output: z.object({ account: mailAccountSchema })
};

/**
 * Show every remote image of this mailbox's messages without asking, tracking
 * pixels included. Off by default.
 */
export const mailAccountSetRemoteImages = {
    command: 'mail.accountSetRemoteImages' as const,
    input: z.object({ id: accountId, allowed: z.boolean() }),
    output: z.object({ account: mailAccountSchema })
};

/**
 * Test IMAP/SMTP reachability either for an already-saved account (`id`) or a
 * not-yet-submitted draft (`draft`) — exactly one must be given, so the "Test
 * connection" button in the add form works before the account exists.
 */
export const mailAccountTestConnection = {
    command: 'mail.accountTestConnection' as const,
    input: z
        .object({ id: accountId.optional(), draft: mailAccountDraftSchema.optional() })
        .refine((v) => Boolean(v.id) !== Boolean(v.draft), {
            message: 'Fournir soit id, soit draft, jamais les deux'
        }),
    output: z.object({ imapOk: z.boolean(), smtpOk: z.boolean(), error: z.string().nullable() })
};

/**
 * Authorization URL to send the browser to for a Google/Microsoft OAuth mailbox.
 * The account row is created server-side once the provider redirects back to the
 * callback HTTP route, never over this WS command; the callback page closes
 * itself via `window.opener.postMessage`, which the client uses to detect
 * completion and refresh `mail.accountList`.
 *
 * Avec `accountId`, le consentement RENOUVELLE cette boîte au lieu d'en créer
 * une : ses messages et ses dossiers restent, seuls ses jetons sont remplacés.
 * C'est la sortie d'un accès révoqué, que supprimer puis recréer paierait du
 * cache entier.
 */
export const mailOAuthStart = {
    command: 'mail.oauthStart' as const,
    input: z.object({
        provider: mailOAuthProviderSchema,
        securityTier: mailSecurityTierSchema,
        /** La boîte à renouveler ; `null` pour en créer une. */
        accountId: accountId.nullable().default(null),
        /**
         * Le nom que la boîte portera dans la liste. Il voyage dans le `state`
         * parce que le compte naît dans la route de callback, hors de toute
         * session : sans lui, la seule chose que le serveur sache nommer est
         * l'adresse rendue par le fournisseur. Vide = l'adresse.
         */
        displayName: z.string().trim().max(MAIL_DISPLAY_NAME_MAX_LENGTH).default('')
    }),
    output: z.object({ authUrl: z.string().url() })
};

export const mailFolderList = {
    command: 'mail.folderList' as const,
    input: z.object({ accountId }),
    output: z.object({ folders: z.array(mailFolderSchema) })
};

export const mailFolderReorder = {
    command: 'mail.folderReorder' as const,
    input: z.object({ accountId, ids: z.array(folderId).min(1) }),
    output: z.object({ ids: z.array(folderId) })
};

/**
 * Force a refresh now instead of waiting for the next background tick (or for
 * guarded accounts, which are never background-synced). Incrémentale : elle
 * rapatrie les arrivées et réconcilie la fenêtre récente, sans rien jeter,
 * contrairement à `mail.folderReset`, qui reconstruit tout.
 */
export const mailFolderSync = {
    command: 'mail.folderSync' as const,
    input: z.object({ folderId }),
    output: z.object({
        ok: z.boolean(),
        newCount: z.number().int().nonnegative(),
        /** Drapeaux corrigés par la passe de réconciliation. */
        changedCount: z.number().int().nonnegative(),
        /** Lignes retirées du cache parce que le serveur ne les a plus. */
        removedCount: z.number().int().nonnegative()
    })
};

/**
 * Fetches one older batch (`limit`, newest-first among the older ones) for a
 * folder: the regular sync only ever moves forward from `last_seen_uid` and can
 * never backfill history that fell outside a folder's initial sync window. Call
 * repeatedly (client-driven, not a server-side loop) until `reachedStart`.
 */
export const mailFolderBackfill = {
    command: 'mail.folderBackfill' as const,
    input: z.object({ folderId, limit: z.number().int().min(1).max(500) }),
    output: z.object({ addedCount: z.number().int().nonnegative(), reachedStart: z.boolean() })
};

/**
 * Drops a folder's whole cache and re-syncs it from scratch. Destructive only in
 * appearance: `mail_messages` is a metadata cache, rebuilt from IMAP, and
 * nothing on the mail server is touched. For when the cache and the mailbox have
 * drifted apart badly enough that reconciling is less trustworthy than starting
 * over.
 */
export const mailFolderReset = {
    command: 'mail.folderReset' as const,
    input: z.object({ folderId }),
    output: z.object({ count: z.number().int().nonnegative() })
};

export const mailMessageList = {
    command: 'mail.messageList' as const,
    input: z.object({
        folderId,
        /** Opaque page cursor from a previous call; `null` for the first page. */
        cursor: mailMessageCursorSchema.nullable(),
        limit: z.number().int().min(1).max(200)
    }),
    output: z.object({
        messages: z.array(mailMessageSummarySchema),
        nextCursor: mailMessageCursorSchema.nullable()
    })
};

/**
 * Search one folder, on two legs that complement each other:
 *
 *  1. Local: decrypts the folder's cached envelopes and filters them on subject,
 *     sender and recipients. Necessarily server-side even though the data is
 *     ours, `envelope_enc` being encrypted at rest. Capped, with `scanned`
 *     reporting how far it reached.
 *  2. Remote: an IMAP `UID SEARCH` against the real mailbox, covering message
 *     bodies and every message that was never synced. Envelopes for hits missing
 *     from the cache are fetched and cached, so a result is a normal row.
 *
 * The remote leg is best-effort: an unreachable mailbox or a refused search
 * still returns the local results, with `remote: false` and `remoteError` set.
 *
 * Whitespace splits the query into terms that must *all* match, in any order.
 * The local leg ignores case and accents (`reunion` finds « Réunion »); the
 * remote leg is at the mercy of the server's own matching, case-insensitive by
 * RFC 3501 but silent about accents.
 */
export const mailMessageSearch = {
    command: 'mail.messageSearch' as const,
    input: z.object({
        folderId,
        query: z.string().min(1).max(MAIL_SEARCH_QUERY_MAX_LENGTH),
        limit: z.number().int().min(1).max(200)
    }),
    output: z.object({
        messages: z.array(mailMessageSummarySchema),
        /** More rows matched than `limit` allowed through — the UI says so rather than implying completeness. */
        truncated: z.boolean(),
        /** Cached envelopes actually examined, so the UI can be honest about how far the search reached. */
        scanned: z.number().int().nonnegative(),
        /** The IMAP leg ran: results cover the whole mailbox and message bodies, not just the cache. */
        remote: z.boolean(),
        /** Why the IMAP leg didn't run or didn't finish. Non-null implies `remote: false`. */
        remoteError: z.string().nullable()
    })
};

/**
 * Fetches the body live from IMAP, never from cache, and runs the
 * sanitize/remote-image-block/suspicious-link pipeline server-side.
 * `allowRemoteImages` unblocks images for this single response only; nothing is
 * persisted about the choice. A mailbox with `allowRemoteImages` set never blocks them.
 */
export const mailMessageGet = {
    command: 'mail.messageGet' as const,
    input: z.object({ messageId, allowRemoteImages: z.boolean() }),
    output: z.object({ message: mailMessageSchema })
};

export const mailMessageSetFlags = {
    command: 'mail.messageSetFlags' as const,
    input: z.object({
        messageId,
        flags: z.object({
            seen: z.boolean().optional(),
            flagged: z.boolean().optional(),
            answered: z.boolean().optional()
        })
    }),
    output: z.object({ message: mailMessageSummarySchema })
};

export const mailMessageMove = {
    command: 'mail.messageMove' as const,
    input: z.object({ messageId, toFolderId: folderId }),
    output: z.object({ id: messageId })
};

export const mailMessageDelete = {
    command: 'mail.messageDelete' as const,
    input: z.object({ messageId }),
    output: z.object({ id: messageId })
};

/** Returns a short-lived ticketed download URL, rather than chunking bytes over WS. */
export const mailAttachmentDownload = {
    command: 'mail.attachmentDownload' as const,
    input: z.object({ messageId, attachmentId: z.string() }),
    output: z.object({ downloadUrl: z.string() })
};

/**
 * Opt-in external scan of one attachment. Rejected with `forbidden` unless the
 * account/message has scanning explicitly enabled — never triggered implicitly.
 */
export const mailAttachmentScan = {
    command: 'mail.attachmentScan' as const,
    input: z.object({ messageId, attachmentId: z.string() }),
    output: z.object({
        status: z.enum(['clean', 'suspicious', 'malicious', 'unknown']),
        provider: z.string().nullable()
    })
};

export const mailSend = {
    command: 'mail.send' as const,
    input: z.object({
        accountId,
        to: z.array(mailAddressSchema).min(1),
        cc: z.array(mailAddressSchema).optional(),
        bcc: z.array(mailAddressSchema).optional(),
        subject: z.string().max(MAIL_SUBJECT_MAX_LENGTH),
        bodyText: z.string(),
        bodyHtml: z.string().nullable().optional(),
        attachments: z
            .array(z.object({ filename: z.string(), mimeType: z.string(), contentBase64: z.string() }))
            .optional(),
        inReplyTo: z.string().nullable().optional()
    }),
    output: z.object({ ok: z.boolean(), messageId: z.string().nullable() })
};

export const mailGetSettings = {
    command: 'mail.getSettings' as const,
    input: z.object({}),
    output: z.object({ settings: mailSettingsSchema })
};

/**
 * Input is `mailSettingsSchema` itself, not a hand-duplicated field list: a
 * settings save always resends the whole object, and a copied shape drifts.
 */
export const mailSetSettings = {
    command: 'mail.setSettings' as const,
    input: mailSettingsSchema,
    output: z.object({ settings: mailSettingsSchema })
};

/**
 * Les fournisseurs dont ce serveur porte les identifiants OAuth : ce que le
 * formulaire d'ajout peut offrir sans envoyer l'utilisateur vers un refus.
 */
export const mailOAuthProviders = {
    command: 'mail.oauthProviders' as const,
    input: z.object({}),
    output: z.object({ configured: z.array(mailOAuthProviderSchema) })
};

export const mailCommands = [
    mailAccountList,
    mailAccountCount,
    mailAccountAdd,
    mailAccountUpdate,
    mailAccountSetProfile,
    mailAccountDelete,
    mailAccountReorder,
    mailAccountSetEnabled,
    mailAccountSetRemoteImages,
    mailAccountTestConnection,
    mailOAuthStart,
    mailOAuthProviders,
    mailFolderList,
    mailFolderReorder,
    mailFolderSync,
    mailFolderBackfill,
    mailFolderReset,
    mailMessageList,
    mailMessageSearch,
    mailMessageGet,
    mailMessageSetFlags,
    mailMessageMove,
    mailMessageDelete,
    mailAttachmentDownload,
    mailAttachmentScan,
    mailSend,
    mailGetSettings,
    mailSetSettings
] as const;
