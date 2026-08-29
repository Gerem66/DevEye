import { z } from 'zod';

/**
 * Mail: user-configured IMAP/SMTP mailboxes, read and sent through DevEye.
 *
 * Storage split (`Docs/SECURITY_MODEL.md`): `securityTier`/`authMethod` and
 * everything the server needs to plan a sync or pick a cipher live in clear
 * columns. Everything identifying (display name, address, credentials, message
 * envelopes) is encrypted, but which cipher is picked per account by
 * `securityTier`, not fixed per feature: an "open" account can be synced and
 * sent in the background, a "guarded" one only ever decrypts during a live,
 * unlocked session. Message bodies and attachments are never persisted, only
 * envelopes are cached; the body is fetched live from IMAP on open.
 */

export const MAIL_DISPLAY_NAME_MAX_LENGTH = 80;
export const MAIL_EMAIL_MAX_LENGTH = 320;
export const MAIL_HOST_MAX_LENGTH = 255;
export const MAIL_SUBJECT_MAX_LENGTH = 998; // RFC 5322 line-length ceiling
export const MAIL_SNIPPET_MAX_LENGTH = 280;

/** Upper bound on a `mail.messageSearch` query — a needle, not a document. */
export const MAIL_SEARCH_QUERY_MAX_LENGTH = 128;

export const MAIL_SYNC_INTERVAL_MIN_MINUTES = 1;
export const MAIL_SYNC_INTERVAL_MAX_MINUTES = 180;
export const MAIL_SYNC_INTERVAL_DEFAULT_MINUTES = 10;

/**
 * Taille d'une page de messages, et de la fenêtre que la synchro relit à chaque
 * passage pour y réconcilier drapeaux et disparus : le même nombre à dessein,
 * pour que la relève garde honnête exactement ce que l'écran affiche sans
 * défiler.
 */
export const MAIL_MESSAGE_PAGE_SIZE = 50;

export const mailSecurityTierSchema = z.enum(['open', 'guarded']);
export type MailSecurityTier = z.infer<typeof mailSecurityTierSchema>;

/**
 * État de la dernière opération tentée sur une boîte, relève de fond ou commande.
 * Trois familles d'échec plutôt qu'un booléen, parce qu'elles n'appellent pas la
 * même chose : `auth` se répare en reconnectant le compte, `unreachable` se
 * répare tout seul quand le réseau revient, `error` demande de lire le message.
 * Le libellé exact reste dans `lastSyncError`, chiffré car il peut citer un hôte.
 */
export const mailAccountStatusSchema = z.enum(['ok', 'auth', 'unreachable', 'error']);
export type MailAccountStatus = z.infer<typeof mailAccountStatusSchema>;

export const mailAuthMethodSchema = z.enum(['password', 'oauth_google', 'oauth_microsoft']);
export type MailAuthMethod = z.infer<typeof mailAuthMethodSchema>;

export const mailOAuthProviderSchema = z.enum(['google', 'microsoft']);
export type MailOAuthProvider = z.infer<typeof mailOAuthProviderSchema>;

export const mailFolderSpecialUseSchema = z.enum(['inbox', 'sent', 'drafts', 'trash', 'junk', 'archive', 'other']);
export type MailFolderSpecialUse = z.infer<typeof mailFolderSpecialUseSchema>;

export const mailProxyKindSchema = z.enum(['socks5', 'http']);
export type MailProxyKind = z.infer<typeof mailProxyKindSchema>;

/** Optional manual proxy for a single account — DevEye never provides one itself. */
export const mailProxySchema = z.object({
    kind: mailProxyKindSchema,
    host: z.string().min(1).max(MAIL_HOST_MAX_LENGTH),
    port: z.number().int().min(1).max(65535),
    username: z.string().max(255).nullable(),
    password: z.string().max(255).nullable()
});
export type MailProxy = z.infer<typeof mailProxySchema>;

const serverEndpointSchema = z.object({
    host: z.string().min(1).max(MAIL_HOST_MAX_LENGTH),
    port: z.number().int().min(1).max(65535),
    username: z.string().min(1).max(MAIL_EMAIL_MAX_LENGTH),
    password: z.string().min(1)
});

/**
 * What the user submits to create/edit a **password**-auth account. OAuth
 * accounts are never drafted this way — they're created by the
 * `mail.oauthStart` → provider redirect → callback flow, which never puts a
 * secret through this schema.
 */
export const mailAccountDraftSchema = z.object({
    displayName: z.string().min(1).max(MAIL_DISPLAY_NAME_MAX_LENGTH),
    emailAddress: z.string().email().max(MAIL_EMAIL_MAX_LENGTH),
    securityTier: mailSecurityTierSchema,
    imap: serverEndpointSchema,
    smtp: serverEndpointSchema,
    proxy: mailProxySchema.nullable()
});
export type MailAccountDraft = z.infer<typeof mailAccountDraftSchema>;

/**
 * Editing an existing password account. Same shape as a draft with two "leave it
 * alone" affordances: a blank username/password keeps the stored one, an omitted
 * `proxy` keeps the stored proxy. Both exist because the account DTO never
 * echoes a secret back, so the form has nothing to prefill.
 */
export const mailAccountEditSchema = mailAccountDraftSchema.extend({
    imap: serverEndpointSchema.extend({
        username: z.string().max(MAIL_EMAIL_MAX_LENGTH),
        password: z.string()
    }),
    smtp: serverEndpointSchema.extend({
        username: z.string().max(MAIL_EMAIL_MAX_LENGTH),
        password: z.string()
    }),
    proxy: mailProxySchema.nullable().optional()
});
export type MailAccountEdit = z.infer<typeof mailAccountEditSchema>;

/**
 * Client-facing account DTO. Never carries a secret: not the IMAP/SMTP password,
 * not the OAuth tokens, not the proxy credentials. Editing a password-auth
 * account re-submits a full new `MailAccountDraft`; there is no "reveal secret"
 * endpoint.
 */
export const mailAccountSchema = z.object({
    id: z.number().int().positive(),
    sortOrder: z.number().int().nonnegative(),
    /**
     * Ce compte vient d'un autre espace, qui le projette ici : il se lit, se
     * relève et expédie normalement, mais l'écran le signale et n'y propose pas
     * les gestes qui restent au domicile (supprimer, changer de palier, retoucher
     * les identifiants). Un compte projeté est toujours ouvert : une boîte gardée
     * ne se projette pas.
     */
    foreign: z.boolean(),
    displayName: z.string(),
    emailAddress: z.string(),
    securityTier: mailSecurityTierSchema,
    authMethod: mailAuthMethodSchema,
    imapHost: z.string(),
    imapPort: z.number().int(),
    smtpHost: z.string(),
    smtpPort: z.number().int(),
    proxyConfigured: z.boolean(),
    enabled: z.boolean(),
    lastSyncAt: z.number().int().nonnegative().nullable(),
    lastSyncError: z.string().nullable(),
    /**
     * État de la dernière opération, persistant jusqu'à ce qu'une réussite le
     * lève. C'est ce qui permet d'annoncer une boîte en panne dès l'ouverture,
     * sans attendre qu'un geste de l'utilisateur reproduise l'échec.
     */
    status: mailAccountStatusSchema,
    /** Quand l'échec courant a été constaté. `null` tant que tout va bien. */
    lastErrorAt: z.number().int().nonnegative().nullable(),
    /** True when an OAuth refresh failed and the user must reconnect. */
    needsReauth: z.boolean(),
    /**
     * How often the background loop re-checks this mailbox, per account rather
     * than per user. Ignored for "guarded" accounts, which are never
     * background-synced; real precision is floored by the server's own tick
     * (`MAIL_SYNC_TICK_SECONDS`), so a lower value just means "every tick".
     */
    syncIntervalMinutes: z.number().int().min(MAIL_SYNC_INTERVAL_MIN_MINUTES).max(MAIL_SYNC_INTERVAL_MAX_MINUTES),
    /** A background sync tick is currently running for this account (in-memory, never persisted). */
    syncing: z.boolean(),
    /**
     * Folder-level fraction (0-1) of the in-progress sync. `null` while `syncing`
     * means "just started, folder count not known yet"; always `null` when not
     * syncing.
     */
    syncProgress: z.number().min(0).max(1).nullable(),
    created: z.number().int().nonnegative()
});
export type MailAccount = z.infer<typeof mailAccountSchema>;

export const mailFolderSchema = z.object({
    id: z.number().int().positive(),
    accountId: z.number().int().positive(),
    name: z.string(),
    specialUse: mailFolderSpecialUseSchema,
    sortOrder: z.number().int().nonnegative(),
    unreadCount: z.number().int().nonnegative(),
    totalCount: z.number().int().nonnegative()
});
export type MailFolder = z.infer<typeof mailFolderSchema>;

export const mailAddressSchema = z.object({
    name: z.string().nullable(),
    address: z.string()
});
export type MailAddress = z.infer<typeof mailAddressSchema>;

export const mailFlagsSchema = z.object({
    seen: z.boolean(),
    flagged: z.boolean(),
    answered: z.boolean(),
    draft: z.boolean()
});
export type MailFlags = z.infer<typeof mailFlagsSchema>;

export const mailAttachmentSchema = z.object({
    id: z.string(),
    filename: z.string(),
    mimeType: z.string(),
    size: z.number().int().nonnegative()
});
export type MailAttachment = z.infer<typeof mailAttachmentSchema>;

/** Why a link was flagged — shown as a warning chip, never blocks the click. */
export const mailLinkWarningReasonSchema = z.enum(['text-href-mismatch', 'lookalike-domain', 'unsafe-scheme']);
export type MailLinkWarningReason = z.infer<typeof mailLinkWarningReasonSchema>;

export const mailSuspiciousLinkSchema = z.object({
    text: z.string(),
    href: z.string(),
    reason: mailLinkWarningReasonSchema
});
export type MailSuspiciousLink = z.infer<typeof mailSuspiciousLinkSchema>;

/**
 * One header line as the server sent it, in receipt order. Kept raw and
 * unabridged: a `Received:` chain or an SPF/DKIM/DMARC verdict is exactly what
 * you need when tracing a message, and any summary would drop the wrong part.
 */
export const mailHeaderSchema = z.object({ name: z.string(), value: z.string() });
export type MailHeader = z.infer<typeof mailHeaderSchema>;

/**
 * Page cursor for `mail.messageList`, opaque to the client: hand back the one
 * from the previous page. A composite of `(date, id)` rather than a bare row id,
 * because the list is ordered by date and row ids are *insertion* order:
 * backfill and remote search write older messages in after newer ones. `id` is
 * only the tiebreak between identical dates, so a page boundary can never repeat
 * or skip a row.
 */
export const mailMessageCursorSchema = z.object({
    date: z.number().int().nonnegative(),
    id: z.number().int().positive()
});
export type MailMessageCursor = z.infer<typeof mailMessageCursorSchema>;

/** List-row shape: the cached envelope, nothing that requires a live IMAP fetch. */
export const mailMessageSummarySchema = z.object({
    id: z.number().int().positive(),
    accountId: z.number().int().positive(),
    folderId: z.number().int().positive(),
    uid: z.number().int().positive(),
    subject: z.string(),
    from: mailAddressSchema.nullable(),
    to: z.array(mailAddressSchema),
    date: z.number().int().nonnegative(),
    flags: mailFlagsSchema,
    hasAttachments: z.boolean(),
    snippet: z.string()
});
export type MailMessageSummary = z.infer<typeof mailMessageSummarySchema>;

/**
 * Full message. Fetched live from IMAP on `mail.messageGet` — never cached —
 * with `bodyHtml` already sanitized server-side (scripts/handlers/tracking CSS
 * stripped, remote images blocked unless `allowRemoteImages` was requested).
 */
export const mailMessageSchema = mailMessageSummarySchema.extend({
    bodyHtml: z.string().nullable(),
    bodyText: z.string().nullable(),
    attachments: z.array(mailAttachmentSchema),
    remoteImagesBlocked: z.boolean(),
    /** Distinct hostnames of the remote images that were blocked, for a "trust these" picker. */
    blockedImageSources: z.array(z.string()),
    suspiciousLinks: z.array(mailSuspiciousLinkSchema),
    /** Every header line as received, in order. Never persisted — read live with the body. */
    headers: z.array(mailHeaderSchema),
    /** Size of the raw RFC822 source, in bytes. */
    sizeBytes: z.number().int().nonnegative(),
    /** IMAP path of the containing mailbox, which with `uid` identifies the message server-side. */
    folderPath: z.string()
});
export type MailMessage = z.infer<typeof mailMessageSchema>;

export const mailBodyRenderModeSchema = z.enum(['embedded', 'raw']);
export type MailBodyRenderMode = z.infer<typeof mailBodyRenderModeSchema>;

export const mailSettingsSchema = z.object({
    /** Off by default; opt-in per workspace. */
    externalScanEnabledDefault: z.boolean(),
    /** Hostnames whose remote images auto-load without a per-message prompt. */
    trustedImageDomains: z.array(z.string()),
    /**
     * `embedded` (default): the sanitized body renders inline, styled by DevEye,
     * without `<style>` or inline styles. `raw`: rendered in a sandboxed iframe
     * with the message's own styling preserved, for when the embedded look
     * mangles a message.
     */
    bodyRenderMode: mailBodyRenderModeSchema
});
export type MailSettings = z.infer<typeof mailSettingsSchema>;

/** Database row shapes (server-only). Mirror the columns exactly. */
export interface MailAccountRow {
    id: number;
    user_id: number;
    workspace_id: number;
    sort_order: number;
    /** Encrypted (tier-dependent). */
    display_name_enc: string;
    /** Encrypted (tier-dependent). */
    email_address_enc: string;
    security_tier: MailSecurityTier;
    auth_method: MailAuthMethod;
    enabled: number;
    /** Background-sync cadence for this mailbox alone. */
    sync_interval_seconds: number;
    last_sync_at: number | null;
    /** Encrypted (tier-dependent), or null after a clean sync. */
    last_sync_error_enc: string | null;
    /**
     * En clair, à côté de `enabled` et `security_tier` : l'état doit être lisible
     * sans clé, par un ordonnanceur qui trie comme par l'interface d'un compte
     * dont le message d'erreur, lui, ne se déchiffre pas.
     */
    last_sync_status: MailAccountStatus;
    last_error_at: number | null;
    /**
     * Encrypted (tier-dependent) JSON blob, the only place secrets live:
     * `{ imap: {host,port,username,password}, smtp: {...}, proxy? }` for
     * `password` auth, `{ provider, accessToken, refreshToken, expiresAt, scope }`
     * for OAuth. Never decrypted into the client-facing DTO.
     */
    credentials_enc: string;
    created: number;
}

export interface MailFolderRow {
    id: number;
    account_id: number;
    /** Clear: the IMAP mailbox path, required to address the mailbox during sync. */
    imap_path: string;
    /** Encrypted (account's tier) display name. */
    name_enc: string;
    special_use: MailFolderSpecialUse;
    sort_order: number;
    /** IMAP UIDVALIDITY — a change invalidates every cached message in this folder. */
    uid_validity: number | null;
    /** High-water mark: forward (incremental) sync fetches strictly after this. */
    last_seen_uid: number | null;
    /** Low-water mark: backward (backfill) sync fetches strictly before this. NULL until the first sync/backfill sets it. */
    first_seen_uid: number | null;
    unread_count: number;
    total_count: number;
}

export interface MailMessageRow {
    id: number;
    folder_id: number;
    uid: number;
    /** Encrypted (account's tier) `{ subject, from, to, snippet }`. Body is never stored. */
    envelope_enc: string;
    date: number;
    seen: number;
    flagged: number;
    answered: number;
    has_attachments: number;
}

export interface MailSettingsRow {
    workspace_id: number;
    external_scan_enabled_default: number;
    /** JSON-encoded string array, or null when empty. Not encrypted — hostnames, not secrets. */
    trusted_image_domains: string | null;
    body_render_mode: MailBodyRenderMode;
}
