import type {
    MailAccount,
    MailAccountRow,
    MailAccountStatus,
    MailAddress,
    MailFolder,
    MailFolderRow,
    MailMessageRow,
    MailMessageSummary,
    MailSecurityTier,
    MailSettings,
    MailSettingsRow
} from '../contracts/domain';
import { FeatureError, type SdkCipher, type SdkFeatureContext } from '@deveye/types/sdk/server';

import type { MailCredentials, MailOAuthCredentials, MailPasswordCredentials, TokenRefreshCallback } from './client';
import { oauthProviderEndpoints } from './oauth';
import type { MailRepo } from './repo';
import { getAccountSyncStatus } from './syncStatus';

/** Le contexte d'une commande de Mail : le contexte du SDK, sur le dépôt du module. */
export type Ctx = SdkFeatureContext<MailRepo>;

/**
 * Depuis le rapatriement, la lecture est implicite (le défaut du SDK) : seules
 * les écritures déclarent leur niveau.
 */
export const WRITE = { level: 'write' } as const;

/**
 * Pick the cipher an account's data is encrypted with, per its own tier.
 *
 * `ctx.cipher()` est l'ex `ctx.secure.open` (l'étage ouvert, celui que le
 * service de fond sait relire seul), `ctx.cipher('private')` l'ex `ctx.secure`
 * (l'étage gardé, qui n'existe que dans une session déverrouillée). Le palier
 * est une colonne en clair précisément pour que ce choix se fasse avant de
 * lire quoi que ce soit.
 */
export function cipherFor(ctx: Ctx, tier: MailSecurityTier): SdkCipher {
    return ctx.cipher(tier === 'open' ? 'server' : 'private');
}

/**
 * Range un échec dans l'une des trois familles d'{@link MailAccountStatus}.
 *
 * Sur le message, faute de mieux : IMAP n'a pas de code d'erreur exploitable —
 * imapflow lève `Error('Command failed')` et laisse la vraie raison dans
 * `responseText`, que `describeError` a déjà repliée dans le message. La
 * classification n'a donc pas à être exhaustive : elle sert à choisir ce que
 * l'interface propose (reconnecter, patienter, lire), et `error` est un défaut
 * honnête pour tout ce qu'on ne reconnaît pas.
 */
export function classifyMailError(message: string): Exclude<MailAccountStatus, 'ok'> {
    const m = message.toLowerCase();
    if (
        /authenticationfailed|invalid credentials|invalid_grant|authentication failed|login failed/.test(m) ||
        // Formulation de Google quand le consentement a été retiré ou a expiré.
        /token has been expired or revoked|invalid[_ ]token|unauthorized|permission denied/.test(m) ||
        // Gmail et Outlook renvoient ceci quand l'accès IMAP est simplement coupé.
        /application-specific password|imap access|authenticate/.test(m)
    ) {
        return 'auth';
    }
    if (
        /econnrefused|enotfound|etimedout|econnreset|ehostunreach|enetunreach|epipe/.test(m) ||
        /timed? ?out|timeout|socket closed|connection closed|n['’]a pas répondu à temps/.test(m) ||
        // Le refus de chiffrer la connexion est un problème de lien, pas d'identité.
        /tls|starttls|certificate/.test(m)
    ) {
        return 'unreachable';
    }
    return 'error';
}

/**
 * Exécute une opération IMAP au nom d'un compte et **en retient l'issue**.
 *
 * Tout ce qui touche au serveur de mail passe par ici, relève de fond comprise
 * (voir `service.ts`), parce qu'un état qui ne s'écrirait que sur un
 * chemin ne vaudrait rien : une boîte dont l'accès a changé doit s'annoncer
 * qu'on l'ouvre, qu'on la relève à la main ou qu'on la laisse tourner seule.
 *
 * L'écriture est faite pour être bon marché sur le cas courant : une réussite
 * qui suit une réussite ne touche pas la base. Seules les transitions écrivent,
 * et ce sont elles que le caller diffuse.
 *
 * L'erreur est toujours relancée : c'est un observateur, pas un filet.
 */
export async function runWithAccountStatus<T>(
    repo: MailRepo,
    cipher: SdkCipher,
    account: MailAccountRow,
    work: () => Promise<T>,
    /** Appelé quand l'état visible du compte a changé, pour prévenir les clients. */
    onStatusChanged?: () => void
): Promise<T> {
    const now = Math.floor(Date.now() / 1000);
    try {
        const result = await work();
        if (account.last_sync_status !== 'ok' || account.last_sync_error_enc !== null) {
            await repo.accounts.recordStatus(account.id, now, null, 'ok');
            onStatusChanged?.();
        }
        return result;
    } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        const status = classifyMailError(message);
        const encrypted = await cipher.encrypt(message);
        await repo.accounts.recordStatus(account.id, now, encrypted, status);
        // Le message chiffré diffère à chaque écriture (nonce), donc on compare
        // ce qui se voit : l'état, et la présence d'une erreur.
        if (account.last_sync_status !== status || account.last_sync_error_enc === null) onStatusChanged?.();
        throw e;
    }
}

/**
 * Ensure a "guarded" account's data is reachable this session. No-op for
 * "open" accounts — they never gate. Mirrors `assertUnlocked` in
 * `features/password/src/server/_shared.ts`, but per-account rather than
 * per-feature.
 *
 * `ctx.secrecy.isUnlocked()` est l'ex `ctx.secure.isUnlocked()` : la même
 * question, posée au verrou du SDK.
 */
export async function assertMailUnlocked(ctx: Ctx, tier: MailSecurityTier): Promise<void> {
    if (tier === 'open') return;
    try {
        if (!(await ctx.secrecy.isUnlocked())) {
            throw new FeatureError('locked', 'Ce compte est verrouillé ; déverrouillez avec votre mot de passe');
        }
    } catch (e) {
        if (e instanceof FeatureError) throw e;
        ctx.logger.warn({ err: e }, 'assertMailUnlocked: failed to check lock state, assuming unlocked');
    }
}

/**
 * Le palier « guarded » n'a de sens que dans un espace personnel : dans un
 * espace partagé, les deux étages utilisent la clé de l'espace, lisible par
 * tout membre, et le palier annoncerait une protection qu'il ne donne pas.
 * Même règle que les notes privées et les projets confidentiels.
 */
export function assertTierAllowed(ctx: Ctx, tier: MailSecurityTier): void {
    if (tier === 'open' || ctx.workspace.kind === 'personal') return;
    throw new FeatureError(
        'validation',
        'Une boîte protégée n’existe que dans votre espace personnel : dans un espace partagé, ' +
            'elle serait lisible par tous les membres.'
    );
}

export async function encryptCredentials(cipher: SdkCipher, credentials: MailCredentials): Promise<string> {
    return cipher.encrypt(JSON.stringify(credentials));
}

export async function decryptCredentials(cipher: SdkCipher, blob: string): Promise<MailCredentials> {
    const plain = await cipher.decrypt(blob);
    return JSON.parse(plain) as MailCredentials;
}

export async function tryDecryptCredentials(cipher: SdkCipher, blob: string): Promise<MailCredentials | null> {
    const plain = await cipher.tryDecrypt(blob);
    if (plain === null) return null;
    try {
        return JSON.parse(plain) as MailCredentials;
    } catch {
        return null;
    }
}

/**
 * The `onTokenRefreshed` hook every `client.ts` call takes: writes a
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
    repo: MailRepo,
    accountId: number,
    credentials: MailCredentials,
    cipher: SdkCipher
): TokenRefreshCallback | undefined {
    if (credentials.kind !== 'oauth') return undefined;
    return async (accessToken, expiresAt) => {
        const updated: MailOAuthCredentials = { ...credentials, accessToken, expiresAt };
        await repo.accounts.updateCredentials(accountId, await cipher.encrypt(JSON.stringify(updated)));
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
export async function reencryptAccountTree(
    repo: MailRepo,
    from: SdkCipher,
    to: SdkCipher,
    accountId: number
): Promise<void> {
    for (const folder of await repo.folders.listByAccount(accountId)) {
        const name = await from.tryDecrypt(folder.name_enc);
        if (name !== null) await repo.folders.updateNameEnc(folder.id, await to.encrypt(name));
        for (const message of await repo.messages.listAllByFolder(folder.id)) {
            const envelope = await from.tryDecrypt(message.envelope_enc);
            if (envelope !== null) await repo.messages.updateEnvelopeEnc(message.id, await to.encrypt(envelope));
        }
    }
}

export async function toAccountDTO(cipher: SdkCipher, row: MailAccountRow): Promise<MailAccount> {
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
        status: row.last_sync_status,
        lastErrorAt: row.last_error_at,
        needsReauth,
        syncIntervalMinutes: Math.max(1, Math.round(row.sync_interval_seconds / 60)),
        syncing: syncStatus.syncing,
        syncProgress: syncStatus.progress,
        created: row.created
    };
}

export async function toFolderDTO(cipher: SdkCipher, row: MailFolderRow): Promise<MailFolder> {
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

export async function encryptEnvelope(cipher: SdkCipher, payload: EnvelopePayload): Promise<string> {
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
        ].join(' ')
    );
    return terms.every((term) => haystack.includes(term));
}

export async function toMessageSummaryDTO(
    cipher: SdkCipher,
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

/** Load a caller-owned account row, or throw `not_found`. */
export async function loadAccount(ctx: Ctx, id: number): Promise<MailAccountRow> {
    const row = await ctx.repo.accounts.findById(id, ctx.workspaceId);
    if (!row) throw new FeatureError('not_found', 'Compte mail introuvable');
    return row;
}

/** Load a folder and its owning account, checking the caller owns it. */
export async function loadFolderWithAccount(
    ctx: Ctx,
    folderId: number
): Promise<{ folder: MailFolderRow; account: MailAccountRow }> {
    const folder = await ctx.repo.folders.findById(folderId);
    if (!folder) throw new FeatureError('not_found', 'Dossier introuvable');
    const account = await loadAccount(ctx, folder.account_id);
    return { folder, account };
}

/** Load a message with its folder + owning account, checking ownership. */
export async function loadMessageChain(
    ctx: Ctx,
    messageId: number
): Promise<{ message: MailMessageRow; folder: MailFolderRow; account: MailAccountRow }> {
    const message = await ctx.repo.messages.findById(messageId);
    if (!message) throw new FeatureError('not_found', 'Message introuvable');
    const { folder, account } = await loadFolderWithAccount(ctx, message.folder_id);
    return { message, folder, account };
}

/** Persist a refreshed OAuth token back onto the account, re-encrypted with the same cipher. */
export function refreshCallback(
    ctx: Ctx,
    account: MailAccountRow,
    credentials: MailCredentials,
    cipher = cipherFor(ctx, account.security_tier)
): TokenRefreshCallback | undefined {
    return persistRefreshedToken(ctx.repo, account.id, credentials, cipher);
}

export type ServerEndpoint = MailPasswordCredentials['imap'];

/** Overlay an edited endpoint on the stored one: blank username/password keep what's there. */
export function mergeEndpoint(next: ServerEndpoint, stored: ServerEndpoint | undefined): ServerEndpoint {
    return {
        host: next.host,
        port: next.port,
        username: next.username || (stored?.username ?? ''),
        password: next.password || (stored?.password ?? '')
    };
}

export async function credentialsFor(ctx: Ctx, account: MailAccountRow): Promise<MailCredentials> {
    return decryptCredentials(cipherFor(ctx, account.security_tier), account.credentials_enc);
}

/**
 * Toute opération de commande qui parle à IMAP, avec l'état du compte tenu à
 * jour au passage — le pendant, côté session, de ce que le service de fond
 * (`service.ts`) fait pour la relève de fond.
 *
 * Passer par ici plutôt que par `credentialsFor` seul est ce qui rend l'état
 * fiable : un accès qui tombe se voit dès l'ouverture de la boîte, sans
 * attendre qu'un tour de relève le constate, et un accès qui revient efface la
 * mention d'erreur sans que personne ait à y penser. Le déchiffrement des
 * identifiants est dedans à dessein — une DEK qui ne se déballe pas est, du
 * point de vue de l'utilisateur, une boîte inaccessible comme une autre.
 */
export async function imapFor<T>(
    ctx: Ctx,
    account: MailAccountRow,
    work: (credentials: MailCredentials) => Promise<T>
): Promise<T> {
    const cipher = cipherFor(ctx, account.security_tier);
    // Rien à diffuser d'ici : les commandes qui écrivent le font déjà par
    // `mutates`, et celles qui lisent rendent l'échec à leur propre appelant,
    // qui relit la liste des comptes dans la foulée (voir le client du module).
    return runWithAccountStatus(ctx.repo, cipher, account, async () => work(await credentialsFor(ctx, account)));
}

/**
 * Finish a tier switch: the caller has already rewritten the account row under
 * `to`, this carries over everything hanging off it (cached folder names and
 * envelopes, plus the last sync error) so nothing is left readable only by the
 * cipher the account no longer uses.
 */
export async function rekeyTier(
    ctx: Ctx,
    previous: MailAccountRow,
    nextTier: MailSecurityTier,
    to: SdkCipher
): Promise<void> {
    const from = cipherFor(ctx, previous.security_tier);
    if (previous.last_sync_error_enc) {
        const error = await from.tryDecrypt(previous.last_sync_error_enc);
        await ctx.repo.accounts.updateSyncError(previous.id, error === null ? null : await to.encrypt(error));
    }
    await reencryptAccountTree(ctx.repo, from, to, previous.id);
    ctx.logger.info(
        { accountId: previous.id, from: previous.security_tier, to: nextTier },
        'Mail account tier changed'
    );
}
