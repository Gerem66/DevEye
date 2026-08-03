import type {
    MailAccount,
    MailAccountRow,
    MailAddress,
    MailFolder,
    MailFolderRow,
    MailMessageRow,
    MailMessageSummary,
    MailSecurityTier,
    MailSettings,
    MailSettingsRow
} from 'deveye-types';
import { createOpenCipher, createSecureStore, type Cipher } from '@/Services/SecureStore';
import type Encryption from '@/Services/Encryption';
import type { Database } from '@/db';
import type { MailCredentials, MailOAuthCredentials, TokenRefreshCallback } from '@/Services/MailAccountClient';
import { oauthProviderEndpoints } from '@/Services/MailOAuth';
import { FeatureError, type FeatureContext } from '../_define';
import { getAccountSyncStatus } from './_syncStatus';

/** Pick the cipher an account's data is encrypted with, per its own tier. */
export function cipherFor(ctx: FeatureContext, tier: MailSecurityTier): Cipher {
    return tier === 'open' ? ctx.secure.open : ctx.secure;
}

/**
 * Same choice as {@link cipherFor}, for the two plain-HTTP routes (OAuth
 * callback, attachment download) that have no `FeatureContext` to read it from
 * and must build the store themselves out of the signed token's claims.
 */
export function cipherForTier(
    db: Database,
    crypt: Encryption,
    userId: number,
    sessionId: string,
    tier: MailSecurityTier
): Cipher {
    if (tier === 'open') return createOpenCipher(db, crypt, userId);
    return createSecureStore(db, crypt, userId, sessionId).store;
}

/**
 * Ensure a "guarded" account's data is reachable this session. No-op for
 * "open" accounts — they never gate. Mirrors `assertSecureUnlocked` in
 * `features/password/_shared.ts`, but per-account rather than per-feature.
 */
export async function assertMailUnlocked(ctx: FeatureContext, tier: MailSecurityTier): Promise<void> {
    if (tier === 'open') return;
    try {
        if (!(await ctx.secure.isUnlocked())) {
            throw new FeatureError('locked', 'Ce compte est verrouillé ; déverrouillez avec votre mot de passe');
        }
    } catch (e) {
        if (e instanceof FeatureError) throw e;
        ctx.logger.warn({ err: e }, 'assertMailUnlocked: failed to check lock state, assuming unlocked');
    }
}

export async function encryptCredentials(cipher: Cipher, credentials: MailCredentials): Promise<string> {
    return cipher.encrypt(JSON.stringify(credentials));
}

export async function decryptCredentials(cipher: Cipher, blob: string): Promise<MailCredentials> {
    const plain = await cipher.decrypt(blob);
    return JSON.parse(plain) as MailCredentials;
}

export async function tryDecryptCredentials(cipher: Cipher, blob: string): Promise<MailCredentials | null> {
    const plain = await cipher.tryDecrypt(blob);
    if (plain === null) return null;
    try {
        return JSON.parse(plain) as MailCredentials;
    } catch {
        return null;
    }
}

/**
 * The `onTokenRefreshed` hook every `MailAccountClient` call takes: writes a
 * freshly minted OAuth access token back onto the account, re-encrypted with
 * the cipher the account is already stored under. `undefined` for a password
 * account, which has no token to refresh — which is also what makes this safe
 * to pass unconditionally at every call site.
 *
 * Single definition on purpose: the same three lines lived in the feature
 * handlers, in the background sync loop and in the attachment route, and a
 * refresh that isn't persisted is invisible until the token expires for good.
 */
export function persistRefreshedToken(
    db: Database,
    accountId: number,
    credentials: MailCredentials,
    cipher: Cipher
): TokenRefreshCallback | undefined {
    if (credentials.kind !== 'oauth') return undefined;
    return async (accessToken, expiresAt) => {
        const updated: MailOAuthCredentials = { ...credentials, accessToken, expiresAt };
        await db.mailAccounts.updateCredentials(accountId, await cipher.encrypt(JSON.stringify(updated)));
    };
}

/**
 * Move an account's cached tree from one tier's cipher to the other.
 *
 * `security_tier` sits in a clear column precisely so the server can pick a
 * cipher before reading anything — but that also means switching it strands
 * every blob already written under the old one. The account row is the obvious
 * part; the folder names and message envelopes underneath it are the part
 * that's easy to forget, and they'd otherwise silently degrade to their
 * "(verrouillé)" fallbacks. Anything that won't decrypt is left untouched
 * rather than overwritten with a re-encrypted placeholder.
 */
export async function reencryptAccountTree(db: Database, from: Cipher, to: Cipher, accountId: number): Promise<void> {
    for (const folder of await db.mailFolders.listByAccount(accountId)) {
        const name = await from.tryDecrypt(folder.name_enc);
        if (name !== null) await db.mailFolders.updateNameEnc(folder.id, await to.encrypt(name));
        for (const message of await db.mailMessages.listAllByFolder(folder.id)) {
            const envelope = await from.tryDecrypt(message.envelope_enc);
            if (envelope !== null) await db.mailMessages.updateEnvelopeEnc(message.id, await to.encrypt(envelope));
        }
    }
}

export async function toAccountDTO(cipher: Cipher, row: MailAccountRow): Promise<MailAccount> {
    const displayName = (await cipher.tryDecrypt(row.display_name_enc)) ?? '(compte verrouillé)';
    const emailAddress = (await cipher.tryDecrypt(row.email_address_enc)) ?? '';
    const lastSyncError = row.last_sync_error_enc ? await cipher.tryDecrypt(row.last_sync_error_enc) : null;
    const credentials = await tryDecryptCredentials(cipher, row.credentials_enc);

    let imapHost = '';
    let imapPort = 0;
    let smtpHost = '';
    let smtpPort = 0;
    let proxyConfigured = false;
    let needsReauth = false;

    if (credentials?.kind === 'password') {
        imapHost = credentials.imap.host;
        imapPort = credentials.imap.port;
        smtpHost = credentials.smtp.host;
        smtpPort = credentials.smtp.port;
        // Loose on purpose, here and below: a blob written before `proxy`
        // existed has no key at all, and `!== null` would report that absence
        // as a configured proxy.
        proxyConfigured = credentials.proxy != null;
    } else if (credentials?.kind === 'oauth') {
        const endpoints = oauthProviderEndpoints(credentials.provider);
        imapHost = endpoints.imapHost;
        imapPort = endpoints.imapPort;
        smtpHost = endpoints.smtpHost;
        smtpPort = endpoints.smtpPort;
        proxyConfigured = credentials.proxy != null;
        // No refresh token and the access token is already stale: the only way
        // out is the user reconnecting through the OAuth flow again.
        needsReauth = !credentials.refreshToken && Date.now() >= credentials.expiresAt;
    }

    const syncStatus = getAccountSyncStatus(row.id);

    return {
        id: row.id,
        sortOrder: row.sort_order,
        displayName,
        emailAddress,
        securityTier: row.security_tier,
        authMethod: row.auth_method,
        imapHost,
        imapPort,
        smtpHost,
        smtpPort,
        proxyConfigured,
        enabled: row.enabled === 1,
        lastSyncAt: row.last_sync_at,
        lastSyncError,
        needsReauth,
        syncIntervalMinutes: Math.max(1, Math.round(row.sync_interval_seconds / 60)),
        syncing: syncStatus.syncing,
        syncProgress: syncStatus.progress,
        created: row.created
    };
}

export async function toFolderDTO(cipher: Cipher, row: MailFolderRow): Promise<MailFolder> {
    const name = (await cipher.tryDecrypt(row.name_enc)) ?? row.imap_path;
    return {
        id: row.id,
        accountId: row.account_id,
        name,
        specialUse: row.special_use,
        sortOrder: row.sort_order,
        unreadCount: row.unread_count,
        totalCount: row.total_count
    };
}

/** The plaintext shape stored (encrypted) in `mail_messages.envelope_enc`. */
export interface EnvelopePayload {
    subject: string;
    from: MailAddress | null;
    to: MailAddress[];
    snippet: string;
}

export async function encryptEnvelope(cipher: Cipher, payload: EnvelopePayload): Promise<string> {
    return cipher.encrypt(JSON.stringify(payload));
}

/** Best-effort parse of `mail_settings.trusted_image_domains` — never throws on a corrupt/legacy value. */
export function parseTrustedImageDomains(raw: string | null): string[] {
    if (!raw) return [];
    try {
        const parsed: unknown = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.filter((d): d is string => typeof d === 'string') : [];
    } catch {
        return [];
    }
}

export function toSettingsDTO(row: MailSettingsRow | null): MailSettings {
    return {
        externalScanEnabledDefault: row?.external_scan_enabled_default === 1,
        trustedImageDomains: parseTrustedImageDomains(row?.trusted_image_domains ?? null),
        bodyRenderMode: row?.body_render_mode ?? 'embedded'
    };
}

/**
 * Case- and accent-insensitive form used on both sides of a search comparison.
 * Folding accents matters here rather than being a nicety: French subjects are
 * full of them, and nobody types `Réunion` into a search box.
 */
function foldForSearch(value: string): string {
    return value
        .normalize('NFD')
        .replace(/\p{Diacritic}/gu, '')
        .toLowerCase();
}

/** Split a raw query into the terms that must *all* match. Empty when the query is only whitespace. */
export function searchTerms(query: string): string[] {
    return foldForSearch(query).split(/\s+/).filter(Boolean);
}

/**
 * Does this envelope match every term? The haystack is everything the cached
 * envelope knows — subject, sender name and address, every recipient, and the
 * snippet — concatenated, so a single box searches all of them at once without
 * the user choosing a field first.
 */
export function messageMatchesTerms(message: MailMessageSummary, terms: string[]): boolean {
    const haystack = foldForSearch(
        [
            message.subject,
            message.from?.name ?? '',
            message.from?.address ?? '',
            ...message.to.flatMap((a) => [a.name ?? '', a.address]),
            message.snippet
        ].join(' ')
    );
    return terms.every((term) => haystack.includes(term));
}

export async function toMessageSummaryDTO(
    cipher: Cipher,
    row: MailMessageRow,
    accountId: number
): Promise<MailMessageSummary> {
    const raw = await cipher.tryDecrypt(row.envelope_enc);
    const envelope: EnvelopePayload = raw
        ? (JSON.parse(raw) as EnvelopePayload)
        : { subject: '(verrouillé)', from: null, to: [], snippet: '' };
    return {
        id: row.id,
        accountId,
        folderId: row.folder_id,
        uid: row.uid,
        subject: envelope.subject,
        from: envelope.from,
        to: envelope.to,
        date: row.date,
        flags: {
            seen: row.seen === 1,
            flagged: row.flagged === 1,
            answered: row.answered === 1,
            // Not tracked per-message in V1; approximated from the folder at the call site.
            draft: false
        },
        hasAttachments: row.has_attachments === 1,
        snippet: envelope.snippet
    };
}
