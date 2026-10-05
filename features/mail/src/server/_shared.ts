import { MAIL_SYNC_INTERVAL_MAX_MINUTES, MAIL_SYNC_INTERVAL_MIN_MINUTES } from '../contracts/domain';
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
import { FeatureError, logFailure, type SdkCipher, type SdkFeatureContext } from '@deveye/types/sdk/server';

// Le garde des appels sortants, partagé par toute l'app : un hôte refusé est un
// réglage à corriger, et se classe donc sans dépendre du texte de son message.
import { UnsafeTargetError } from '@/Services/netFetch';

import { MailReauthRequiredError, withSession, type MailSession } from './client';
import type { MailCredentials, MailPasswordCredentials, TokenRefreshCallback } from './client';
import { oauthProviderEndpoints, OAuthTokenError } from './oauth';
import type { MailRepo } from './repo';
import { getAccountSyncStatus } from './syncStatus';

export type Ctx = SdkFeatureContext<MailRepo>;

/** La lecture est implicite (le défaut du SDK) : seules les écritures déclarent leur niveau. */
export const WRITE = { level: 'write' } as const;

/**
 * Pick the cipher an account's data is encrypted with, per its own tier.
 *
 * Le palier est une colonne en clair précisément pour que ce choix se fasse
 * avant de lire quoi que ce soit.
 */
export function cipherFor(ctx: Ctx, tier: MailSecurityTier): SdkCipher {
    return ctx.cipher(tier === 'open' ? 'server' : 'private');
}

/** Ce compte vit dans un autre espace, qui le projette ici. */
export function isForeign(ctx: Ctx, account: MailAccountRow): boolean {
    return account.workspace_id !== ctx.workspaceId;
}

/**
 * Le codec sous lequel les données d'un compte existant sont écrites : chez lui
 * {@link cipherFor} par son palier, projeté d'ailleurs le codec ouvert de son
 * espace d'origine, que seul `ctx.sharing.scope()` sait rendre (`Docs/SHARING.md`
 * §3). Le déchiffrer avec celui d'ici rendrait un nom vide plutôt qu'une erreur.
 */
export async function accountCipher(ctx: Ctx, account: MailAccountRow): Promise<SdkCipher> {
    if (!isForeign(ctx, account)) return cipherFor(ctx, account.security_tier);
    return (await ctx.sharing.scope()).cipherFor(String(account.id));
}

/**
 * Refuse un geste réservé au domicile sur un compte projeté : supprimer le
 * compte, changer son palier ou retoucher ses identifiants touchent la donnée
 * d'un autre espace, et le palier relie la boîte au mot de passe de son auteur,
 * que la fenêtre ne voit pas.
 */
export function assertAtHome(ctx: Ctx, account: MailAccountRow, gesture: string): void {
    if (!isForeign(ctx, account)) return;
    throw new FeatureError(
        'validation',
        `Cette boîte appartient à un autre espace, qui la partage ici : ${gesture} se fait depuis son espace d’origine.`
    );
}

/**
 * Range un échec dans l'une des trois familles d'{@link MailAccountStatus}. Sur
 * le message faute de mieux : IMAP n'a pas de code exploitable, imapflow lève
 * `Error('Command failed')` et laisse la raison dans le message. La
 * classification n'a pas à être exhaustive : elle choisit ce que l'interface
 * propose, et `error` couvre tout ce qu'on ne reconnaît pas.
 */
export function classifyMailError(error: unknown): Exclude<MailAccountStatus, 'ok'> {
    // Les deux cas où la conduite à tenir est connue sans lire de texte : le
    // fournisseur a définitivement refusé, et lui seul peut rendre l'accès, ou
    // son point de jetons a flanché sans que rien soit révoqué.
    if (error instanceof MailReauthRequiredError) return 'auth';
    // Ni une panne ni un refus d'identité : l'adresse saisie est hors des clous
    // de l'instance. La reprise de `syncFoldersWithRetry` n'a rien à y gagner.
    if (error instanceof UnsafeTargetError) return 'error';
    if (error instanceof OAuthTokenError) return error.permanent ? 'auth' : 'unreachable';
    const m = (error instanceof Error ? error.message : String(error)).toLowerCase();
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
        /tls|starttls|certificate/.test(m) ||
        // Refus passagers de Gmail, qui répond ceci quand son propre stockage ne
        // rend pas la boîte : une autorisation encore en cours de propagation,
        // une indisponibilité de quelques secondes. La conduite à tenir est
        // d'attendre, pas de toucher aux réglages.
        /lookup failed|temporary (system )?(error|failure)|unavailable|too many simultaneous/.test(m)
    ) {
        return 'unreachable';
    }
    return 'error';
}

/** Une boîte qui refuse l'accès, ne répond pas ou pointe hors des adresses permises regarde son propriétaire. */
export function isOwnerSideMailError(error: unknown): boolean {
    return error instanceof UnsafeTargetError || classifyMailError(error) !== 'error';
}

/**
 * Exécute une opération IMAP au nom d'un compte et en retient l'issue. Tout ce
 * qui touche au serveur de mail passe par ici, relève de fond comprise : un
 * état qui ne s'écrirait que sur un chemin ne vaudrait rien. Seules les
 * transitions écrivent, et ce sont elles que l'appelant diffuse. L'erreur est
 * toujours relancée : c'est un observateur, pas un filet.
 */
export async function runWithAccountStatus<T>(
    repo: MailRepo,
    cipher: SdkCipher,
    account: MailAccountRow,
    work: () => Promise<T>,
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
        const status = classifyMailError(e);
        const encrypted = await cipher.encrypt(message);
        await repo.accounts.recordStatus(account.id, now, encrypted, status);
        // Le message chiffré diffère à chaque écriture (nonce), donc on compare
        // ce qui se voit : l'état, et la présence d'une erreur.
        if (account.last_sync_status !== status || account.last_sync_error_enc === null) onStatusChanged?.();
        throw e;
    }
}

/**
 * Ensure a "guarded" account's data is reachable this session. No-op for "open"
 * accounts, which never gate.
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
 * The `onTokenRefreshed` hook every `client.ts` call takes: writes a freshly
 * minted OAuth access token back onto the account, re-encrypted with the cipher
 * the account is already stored under. `undefined` for a password account,
 * which has no token to refresh, so it is safe to pass at every call site.
 */
export function persistRefreshedToken(
    repo: MailRepo,
    accountId: number,
    credentials: MailCredentials,
    cipher: SdkCipher
): TokenRefreshCallback | undefined {
    if (credentials.kind !== 'oauth') return undefined;
    const oauth = credentials;
    return async ({ accessToken, expiresAt, refreshToken }) => {
        // L'objet est muté, pas recopié : la relève de fond déchiffre les
        // identifiants une fois pour toute la passe et les repasse par
        // référence à chaque dossier, qui relirait sinon une échéance périmée
        // et redemanderait un jeton par dossier.
        oauth.accessToken = accessToken;
        oauth.expiresAt = expiresAt;
        // Microsoft fait tourner ses jetons de rafraîchissement : garder
        // l'ancien perd la boîte au bout de la fenêtre glissante.
        if (refreshToken) oauth.refreshToken = refreshToken;
        await repo.accounts.updateCredentials(accountId, await cipher.encrypt(JSON.stringify(oauth)));
    };
}

/**
 * Move an account's cached tree from one tier's cipher to the other: switching
 * `security_tier` otherwise strands the folder names and envelopes written
 * under the old one, which would silently degrade to their "(verrouillé)"
 * fallbacks. Anything that won't decrypt is left untouched rather than
 * overwritten with a re-encrypted placeholder.
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

/**
 * Le DTO d'un compte, sous le codec de son domicile ({@link accountCipher}) ;
 * `foreign` dit à l'écran qu'il regarde une fenêtre sur un autre espace.
 */
export async function toAccountDTO(
    cipher: SdkCipher,
    row: MailAccountRow,
    foreign: boolean,
    planPaused: boolean
): Promise<MailAccount> {
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
        // existed has no key at all, and `!== null` would read as configured.
        proxyConfigured = credentials.proxy != null;
    } else if (credentials?.kind === 'oauth') {
        const endpoints = oauthProviderEndpoints(credentials.provider);
        imapHost = endpoints.imapHost;
        imapPort = endpoints.imapPort;
        smtpHost = endpoints.smtpHost;
        smtpPort = endpoints.smtpPort;
        proxyConfigured = credentials.proxy != null;
        // Deux impasses dont seule une reconnexion sort : plus de jeton de
        // rafraîchissement avec un accès périmé, ou un fournisseur qui a refusé
        // de le renouveler (`auth` sur un compte géré ne peut venir que de là,
        // ses identifiants n'étant jamais saisis).
        needsReauth =
            (!credentials.refreshToken && Date.now() >= credentials.expiresAt) || row.last_sync_status === 'auth';
    }

    const syncStatus = getAccountSyncStatus(row.id);

    return {
        id: row.id,
        sortOrder: row.sort_order,
        foreign,
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
        allowRemoteImages: row.allow_remote_images === 1,
        lastSyncAt: row.last_sync_at,
        lastSyncError,
        status: row.last_sync_status,
        lastErrorAt: row.last_error_at,
        needsReauth,
        // Borné aux mêmes valeurs que le contrat : une ligne venue d'une autre
        // instance peut porter une cadence que l'écran ne sait plus produire, et
        // la validation de sortie ferait tomber tout le listage de l'espace.
        syncIntervalMinutes: Math.min(
            MAIL_SYNC_INTERVAL_MAX_MINUTES,
            Math.max(MAIL_SYNC_INTERVAL_MIN_MINUTES, Math.round(row.sync_interval_seconds / 60))
        ),
        syncing: syncStatus.syncing,
        syncProgress: syncStatus.progress,
        planPaused,
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
 * Case- and accent-insensitive form used on both sides of a search comparison:
 * French subjects are full of accents, and nobody types `Réunion` into a box.
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
 * envelope knows (subject, sender, recipients, snippet) concatenated, so one
 * box searches all of them without the user choosing a field first.
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

/** Le niveau qu'une commande exige sur le compte qu'elle vise. */
export type ItemLevel = 'read' | 'write';

/**
 * Un compte visible depuis cet espace : le sien, ou un qu'un autre espace y
 * projette ; `not_found` sinon. `level` passe par `ctx.items.assert`, qui
 * refuse en plus les comptes qu'une restriction de rôle masque ou passe en
 * lecture seule : la permission de feature seule n'y répond pas.
 */
export async function loadAccount(ctx: Ctx, id: number, level: ItemLevel = 'read'): Promise<MailAccountRow> {
    const row = await ctx.repo.accounts.findVisible(id, ctx.workspaceId);
    if (!row) throw new FeatureError('not_found', 'Compte mail introuvable');
    await ctx.items.assert(String(id), level);
    return row;
}

/** Load a folder and its account, checking the account is visible from here at `level`. */
export async function loadFolderWithAccount(
    ctx: Ctx,
    folderId: number,
    level: ItemLevel = 'read'
): Promise<{ folder: MailFolderRow; account: MailAccountRow }> {
    const folder = await ctx.repo.folders.findById(folderId);
    if (!folder) throw new FeatureError('not_found', 'Dossier introuvable');
    const account = await loadAccount(ctx, folder.account_id, level);
    return { folder, account };
}

/** Load a message with its folder + account, checking the account is visible from here at `level`. */
export async function loadMessageChain(
    ctx: Ctx,
    messageId: number,
    level: ItemLevel = 'read'
): Promise<{ message: MailMessageRow; folder: MailFolderRow; account: MailAccountRow }> {
    const message = await ctx.repo.messages.findById(messageId);
    if (!message) throw new FeatureError('not_found', 'Message introuvable');
    const { folder, account } = await loadFolderWithAccount(ctx, message.folder_id, level);
    return { message, folder, account };
}

/**
 * Persist a refreshed OAuth token back onto the account, re-encrypted with
 * `cipher`, which must be the one the account is stored under
 * ({@link accountCipher}: the home's, for a projected account).
 */
export function refreshCallback(
    ctx: Ctx,
    account: MailAccountRow,
    credentials: MailCredentials,
    cipher: SdkCipher
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
    return decryptCredentials(await accountCipher(ctx, account), account.credentials_enc);
}

/**
 * Même duck-typing que l'hôte (`src/ws/handler.ts`) : un module et l'app
 * peuvent résoudre deux instances distinctes de `@deveye/types`, et traduire
 * par erreur un `locked` du codec fermerait l'invite de déverrouillage.
 */
function isFeatureError(e: unknown): e is FeatureError {
    return e instanceof FeatureError || (e instanceof Error && e.name === 'FeatureError' && 'code' in e);
}

/**
 * Le mot que l'écran reçoit quand une commande bute sur le serveur de mail.
 * `validation` et non un code d'authentification : `auth_required` et
 * `auth_expired` sont captés par la couche de session du client, qui
 * déconnecterait DevEye entier.
 */
function mailCommandFailure(error: unknown): FeatureError {
    switch (classifyMailError(error)) {
        case 'auth':
            return new FeatureError(
                'validation',
                'Le fournisseur a refusé l’accès à cette boîte. Reconnectez-la depuis la bannière ou ses réglages.'
            );
        case 'unreachable':
            return new FeatureError(
                'validation',
                'Le serveur de mail ne répond pas pour le moment. Réessayez dans un instant.'
            );
        case 'error': {
            // Le même texte que `runWithAccountStatus` vient de persister et
            // que la bannière montre déjà au même utilisateur.
            const detail = (error instanceof Error ? error.message : String(error)).slice(0, 300);
            return new FeatureError('validation', `L’opération sur cette boîte a échoué : ${detail}`);
        }
    }
}

/**
 * Toute opération de commande qui parle à IMAP ou SMTP, avec l'état du compte
 * tenu à jour au passage : un accès qui tombe se voit dès l'ouverture de la
 * boîte, sans attendre un tour de relève, et un accès qui revient efface la
 * mention d'erreur. Le déchiffrement des identifiants est dedans à dessein :
 * une DEK qui ne se déballe pas est une boîte inaccessible comme une autre. Un
 * compte que l'offre tient en pause est refusé ici, avant toute connexion.
 */
export async function imapFor<T>(
    ctx: Ctx,
    account: MailAccountRow,
    work: (credentials: MailCredentials) => Promise<T>
): Promise<T> {
    await ctx.quota.assertActive('accounts', String(account.id));
    const cipher = await accountCipher(ctx, account);
    try {
        // Rien à diffuser d'ici : les commandes qui écrivent le font par
        // `mutates`, et celles qui lisent rendent l'échec à leur appelant, qui
        // relit la liste.
        return await runWithAccountStatus(ctx.repo, cipher, account, async () =>
            work(await credentialsFor(ctx, account))
        );
    } catch (e) {
        // L'état du compte vient d'être écrit par `runWithAccountStatus` ; il
        // ne reste qu'à rendre à l'appelant de quoi le montrer, au lieu du
        // « Internal server error » que l'hôte donne à toute erreur non typée.
        if (isFeatureError(e)) throw e;
        logFailure(ctx.logger, isOwnerSideMailError(e), { err: e, accountId: account.id }, 'Mail command failed');
        throw mailCommandFailure(e);
    }
}

/**
 * {@link imapFor} pour une suite d'opérations : une seule connexion ouverte,
 * prêtée au travail puis refermée. Toute relève passe par là, parce qu'elle
 * parcourt des dossiers et que la poignée de main est le coût dominant
 * ({@link MailSession}).
 */
export async function sessionFor<T>(
    ctx: Ctx,
    account: MailAccountRow,
    cipher: SdkCipher,
    work: (session: MailSession) => Promise<T>
): Promise<T> {
    return imapFor(ctx, account, (credentials) =>
        withSession(credentials, refreshCallback(ctx, account, credentials, cipher), work)
    );
}

/**
 * Finish a tier switch: the caller has already rewritten the account row under
 * `to`, this carries over everything hanging off it (cached folder names and
 * envelopes, plus the last sync error).
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
    // Une boîte gardée ne se lit que chez son auteur : ses projections n'ont
    // plus d'objet, et sans ce ménage une ligne `item_shares` dormante
    // remontrerait la boîte le jour où elle rouvre.
    if (nextTier === 'guarded') await ctx.items.forget(String(previous.id));
    ctx.logger.info(
        { accountId: previous.id, from: previous.security_tier, to: nextTier },
        'Mail account tier changed'
    );
}
