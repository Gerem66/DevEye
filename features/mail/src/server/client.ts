import { ImapFlow, type FetchMessageObject, type ImapFlowOptions, type ListResponse } from 'imapflow';
import nodemailer, { type Transporter } from 'nodemailer';
import type { MailAddress, MailFolderSpecialUse, MailOAuthProvider, MailProxy } from '../contracts/domain';
// Le garde des appels sortants, partagé par toute l'app : les serveurs IMAP,
// SMTP et le proxy d'une boîte sont saisis par un membre, et rien d'autre
// n'empêche le serveur d'aller frapper à une adresse de son réseau interne.
import { assertAllowedOutboundHost, publicLookup } from '@/Services/netFetch';

import { oauthProviderEndpoints, refreshAccessToken, OAuthTokenError, type RefreshedToken } from './oauth';

/**
 * Talks IMAP/SMTP for one mail account, for either auth method: `password`
 * (plain username/password) or `oauth` (SASL XOAUTH2 against the provider's
 * standard IMAP/SMTP endpoints, not the Gmail/Graph API), so one code path
 * covers both. An expiring access token is refreshed here; the caller supplies
 * {@link TokenRefreshCallback} to persist it.
 *
 * TLS is never optional: implicit TLS (port 993/465) uses `secure: true`, every
 * other port requires STARTTLS via `doSTARTTLS`/`requireTLS`, which fails the
 * connection outright rather than falling back to plaintext.
 */

export interface MailPasswordCredentials {
    kind: 'password';
    imap: { host: string; port: number; username: string; password: string };
    smtp: { host: string; port: number; username: string; password: string };
    proxy: MailProxy | null;
}

export interface MailOAuthCredentials {
    kind: 'oauth';
    provider: MailOAuthProvider;
    email: string;
    accessToken: string;
    refreshToken: string | null;
    /** Epoch ms. */
    expiresAt: number;
    /** Same manual proxy option as a password account. */
    proxy: MailProxy | null;
}

export type MailCredentials = MailPasswordCredentials | MailOAuthCredentials;

/**
 * Called when an OAuth access token had to be minted mid-operation, so the
 * caller can persist it. `undefined` for password auth.
 */
export type TokenRefreshCallback = (tokens: RefreshedToken) => Promise<void>;

/**
 * Le fournisseur refuse de renouveler l'accès : consentement retiré, jeton de
 * rafraîchissement révoqué, secret client changé. Seule une reconnexion en sort,
 * et c'est une classe et non un motif de message parce que la raison arrive du
 * fournisseur telle quelle et n'a aucune forme garantie (« Bad Request » en est
 * une). Le message d'origine reste en `cause`, c'est lui qu'on montre.
 */
export class MailReauthRequiredError extends Error {
    constructor(
        readonly provider: MailOAuthProvider,
        cause: unknown,
        reason = 'Le fournisseur a refusé de renouveler l’accès'
    ) {
        const detail = cause instanceof Error ? cause.message : String(cause);
        super(`${reason} : ${detail}`);
        this.name = 'MailReauthRequiredError';
        this.cause = cause;
    }
}

interface ResolvedAuth {
    imapHost: string;
    imapPort: number;
    smtpHost: string;
    smtpPort: number;
    imapAuth: { user: string; pass?: string; accessToken?: string };
    smtpAuth: { type: 'login'; user: string; pass: string } | { type: 'OAuth2'; user: string; accessToken: string };
    /** Proxy URL (socks5:/http:/https:) for the IMAP connection, or null; SMTP is not proxied. */
    imapProxy: string | null;
}

/** Refresh an OAuth token this long before it actually expires. */
const OAUTH_REFRESH_MARGIN_MS = 120_000;

function proxyUrl(proxy: MailProxy | null | undefined): string | null {
    if (!proxy) return null;
    const scheme = proxy.kind === 'socks5' ? 'socks5' : 'http';
    const auth = proxy.username
        ? `${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password ?? '')}@`
        : '';
    return `${scheme}://${auth}${proxy.host}:${proxy.port}`;
}

export async function resolveAuth(
    credentials: MailCredentials,
    onTokenRefreshed?: TokenRefreshCallback
): Promise<ResolvedAuth> {
    if (credentials.kind === 'password') {
        return {
            imapHost: credentials.imap.host,
            imapPort: credentials.imap.port,
            smtpHost: credentials.smtp.host,
            smtpPort: credentials.smtp.port,
            imapAuth: { user: credentials.imap.username, pass: credentials.imap.password },
            smtpAuth: { type: 'login', user: credentials.smtp.username, pass: credentials.smtp.password },
            imapProxy: proxyUrl(credentials.proxy)
        };
    }
    const endpoints = oauthProviderEndpoints(credentials.provider);
    let accessToken = credentials.accessToken;
    if (Date.now() >= credentials.expiresAt - OAUTH_REFRESH_MARGIN_MS) {
        if (!credentials.refreshToken) {
            throw new MailReauthRequiredError(
                credentials.provider,
                'aucun jeton de rafraîchissement n’est stocké pour cette boîte',
                'La session du fournisseur a expiré'
            );
        }
        // Un refus définitif n'est pas un incident de relève : le compte ne
        // repartira pas tout seul, et le dire dès la source évite d'avoir à
        // deviner la conduite à tenir depuis le texte du fournisseur. Un délai
        // dépassé, un 5xx ou un plafond d'appels laissent le consentement
        // intact, et les annoncer « reconnectez-le » enverrait défaire ce qui
        // marche : ils repartent tels quels.
        let refreshed: RefreshedToken;
        try {
            refreshed = await refreshAccessToken(credentials.provider, credentials.refreshToken);
        } catch (e) {
            if (e instanceof OAuthTokenError && e.permanent) {
                throw new MailReauthRequiredError(credentials.provider, e);
            }
            throw e;
        }
        accessToken = refreshed.accessToken;
        if (onTokenRefreshed) await onTokenRefreshed(refreshed);
    }
    return {
        imapHost: endpoints.imapHost,
        imapPort: endpoints.imapPort,
        smtpHost: endpoints.smtpHost,
        smtpPort: endpoints.smtpPort,
        imapAuth: { user: credentials.email, accessToken },
        smtpAuth: { type: 'OAuth2', user: credentials.email, accessToken },
        imapProxy: proxyUrl(credentials.proxy)
    };
}

/** `ImapFlowOptions` doesn't declare `doSTARTTLS` in its published types, though the runtime accepts it. */
type StrictImapFlowOptions = ImapFlowOptions & { doSTARTTLS?: boolean };

/**
 * imapflow never folds the server's own explanation into `Error.message`: a
 * failed IMAP command throws a generic `Error('Command failed')` with the real
 * reason on `.responseText` (or `.response` for `AuthenticationFailure`).
 */
function describeError(e: unknown): string {
    if (e && typeof e === 'object') {
        const err = e as { message?: string; responseText?: unknown; response?: unknown };
        const detail =
            typeof err.responseText === 'string' && err.responseText
                ? err.responseText
                : typeof err.response === 'string' && err.response
                  ? err.response
                  : null;
        if (detail) return err.message ? `${err.message} : ${detail}` : detail;
    }
    return e instanceof Error ? e.message : String(e);
}

async function withImap<T>(auth: ResolvedAuth, fn: (client: ImapFlow) => Promise<T>): Promise<T> {
    await assertAllowedOutboundHost(auth.imapHost);
    // Le proxy est l'autre bout du même fil : sans lui, l'interdit se contourne
    // en faisant sortir la connexion par une adresse interne.
    if (auth.imapProxy) await assertAllowedOutboundHost(new URL(auth.imapProxy).hostname);

    const implicitTls = auth.imapPort === 993;
    const options: StrictImapFlowOptions = {
        host: auth.imapHost,
        port: auth.imapPort,
        secure: implicitTls,
        doSTARTTLS: implicitTls ? undefined : true,
        auth: auth.imapAuth,
        proxy: auth.imapProxy ?? undefined,
        // imapflow verse ces options dans `tls.connect` comme dans `net.connect` :
        // le `lookup` couvre donc les deux chemins, et referme la fenêtre entre
        // la vérification ci-dessus et la connexion (rebinding DNS).
        tls: { lookup: publicLookup },
        // Délais resserrés sur ceux d'imapflow (90 s / 16 s / 5 min) : la relève
        // de fond n'a que `MAIL_SYNC_CONCURRENCY` places, et un serveur muet en
        // immobiliserait une cinq minutes durant.
        connectionTimeout: 30_000,
        greetingTimeout: 15_000,
        socketTimeout: 60_000,
        logger: false
    };
    const client = new ImapFlow(options);
    try {
        await client.connect();
        if (!client.secureConnection) {
            throw new Error('La connexion IMAP n’a pas pu être chiffrée (TLS/STARTTLS requis)');
        }
        return await fn(client);
    } catch (e) {
        throw new Error(describeError(e));
    } finally {
        try {
            await client.logout();
        } catch {
            client.close();
        }
    }
}

/**
 * {@link withImap} plus an exclusive lock on one mailbox, released whatever
 * happens. Every per-message operation needs both, and a lock leaked on an
 * error path wedges every later operation on that connection.
 */
async function withMailbox<T>(auth: ResolvedAuth, imapPath: string, fn: (client: ImapFlow) => Promise<T>): Promise<T> {
    return withImap(auth, async (client) => {
        const lock = await client.getMailboxLock(imapPath);
        try {
            return await fn(client);
        } finally {
            lock.release();
        }
    });
}

/** The open mailbox's state, or a clear error when the path doesn't resolve to one. */
function requireMailbox(client: ImapFlow): Exclude<ImapFlow['mailbox'], boolean | undefined> {
    const box = client.mailbox;
    if (!box || typeof box === 'boolean') throw new Error('Dossier introuvable');
    return box;
}

/**
 * Asynchrone pour son seul garde : nodemailer résout le nom lui-même avant de
 * se connecter, donc un `lookup` n'y a aucune prise et la vérification doit
 * précéder. Il reste une fenêtre de rebinding entre les deux, que rien ne
 * ferme sans réécrire la résolution de nodemailer.
 */
async function smtpTransport(auth: ResolvedAuth): Promise<Transporter> {
    await assertAllowedOutboundHost(auth.smtpHost);
    const implicitTls = auth.smtpPort === 465;
    return nodemailer.createTransport({
        host: auth.smtpHost,
        port: auth.smtpPort,
        secure: implicitTls,
        requireTLS: implicitTls ? undefined : true,
        auth:
            auth.smtpAuth.type === 'login'
                ? { user: auth.smtpAuth.user, pass: auth.smtpAuth.pass }
                : { type: 'OAuth2', user: auth.smtpAuth.user, accessToken: auth.smtpAuth.accessToken }
    });
}

export async function testConnection(
    credentials: MailCredentials,
    onTokenRefreshed?: TokenRefreshCallback
): Promise<{ imapOk: boolean; smtpOk: boolean; error: string | null }> {
    let imapOk = false;
    let smtpOk = false;
    const errors: string[] = [];
    try {
        const auth = await resolveAuth(credentials, onTokenRefreshed);
        try {
            await withImap(auth, async () => {});
            imapOk = true;
        } catch (e) {
            errors.push(`IMAP : ${e instanceof Error ? e.message : String(e)}`);
        }
        const transport = await smtpTransport(auth);
        try {
            await transport.verify();
            smtpOk = true;
        } catch (e) {
            errors.push(`SMTP : ${e instanceof Error ? e.message : String(e)}`);
        } finally {
            transport.close();
        }
    } catch (e) {
        errors.push(e instanceof Error ? e.message : String(e));
    }
    return { imapOk, smtpOk, error: errors.length > 0 ? errors.join(' — ') : null };
}

export interface RemoteFolder {
    imapPath: string;
    name: string;
    specialUse: MailFolderSpecialUse;
}

const SPECIAL_USE_MAP: Record<string, MailFolderSpecialUse> = {
    '\\Inbox': 'inbox',
    '\\Sent': 'sent',
    '\\Drafts': 'drafts',
    '\\Trash': 'trash',
    '\\Junk': 'junk',
    '\\Archive': 'archive'
};

export async function listFolders(
    credentials: MailCredentials,
    onTokenRefreshed?: TokenRefreshCallback
): Promise<RemoteFolder[]> {
    const auth = await resolveAuth(credentials, onTokenRefreshed);
    return withImap(auth, async (client) => {
        const list: ListResponse[] = await client.list();
        return list
            .filter((f) => f.listed && !f.flags.has('\\Noselect'))
            .map((f) => ({
                imapPath: f.path,
                name: f.name,
                specialUse: SPECIAL_USE_MAP[f.specialUse ?? ''] ?? 'other'
            }));
    });
}

export interface RemoteEnvelope {
    uid: number;
    subject: string;
    from: MailAddress | null;
    to: MailAddress[];
    /** Epoch seconds. */
    date: number;
    seen: boolean;
    flagged: boolean;
    answered: boolean;
    hasAttachments: boolean;
}

/** Does this body-structure tree contain a part disposed as an attachment? */
function hasAttachmentPart(node: FetchMessageObject['bodyStructure']): boolean {
    if (!node) return false;
    if (node.disposition && node.disposition.toLowerCase() === 'attachment') return true;
    if (node.childNodes) return node.childNodes.some(hasAttachmentPart);
    return false;
}

function toAddress(a?: { name?: string; address?: string }): MailAddress | null {
    if (!a?.address) return null;
    return { name: a.name || null, address: a.address };
}

/** Shared envelope mapping between {@link syncFolder} and {@link fetchOlderMessages}. */
function mapFetchedMessage(msg: FetchMessageObject): RemoteEnvelope {
    const flags = msg.flags ?? new Set<string>();
    return {
        uid: msg.uid,
        subject: msg.envelope?.subject ?? '(sans objet)',
        from: toAddress(msg.envelope?.from?.[0]),
        to: (msg.envelope?.to ?? []).map(toAddress).filter((a): a is MailAddress => a !== null),
        date: Math.floor((msg.envelope?.date ?? (msg.internalDate as Date | undefined) ?? new Date()).getTime() / 1000),
        seen: flags.has('\\Seen'),
        flagged: flags.has('\\Flagged'),
        answered: flags.has('\\Answered'),
        hasAttachments: hasAttachmentPart(msg.bodyStructure)
    };
}

const FETCH_QUERY = { uid: true, envelope: true, flags: true, bodyStructure: true, internalDate: true } as const;

/** Réconciliation : les drapeaux seuls, l'enveloppe en cache ne changeant jamais. */
const FLAGS_QUERY = { uid: true, flags: true } as const;

export interface RemoteFlags {
    uid: number;
    seen: boolean;
    flagged: boolean;
    answered: boolean;
}

/** Fenêtre du cache à relire, bornes incluses. */
export interface ReconcileWindow {
    fromUid: number;
    toUid: number;
}

export interface SyncFolderOptions {
    credentials: MailCredentials;
    imapPath: string;
    sinceUid: number | null;
    initialLimit: number;
    /**
     * Fenêtre déjà en cache à relire au passage, sur la connexion et le verrou
     * du fetch avant : ouvrir la boîte est le coût dominant.
     */
    reconcile?: ReconcileWindow | null;
    onTokenRefreshed?: TokenRefreshCallback;
    onProgress?: (done: number, estimatedTotal: number) => void;
}

export interface FolderSyncResult {
    /** Compared against the cached value by the caller; a change invalidates the whole folder cache. */
    uidValidity: number;
    messages: RemoteEnvelope[];
    /**
     * Ce que le serveur possède encore dans la fenêtre demandée. `null` quand
     * aucune réconciliation n'a été demandée, à ne pas confondre avec `[]`, qui
     * veut dire « plus rien de cette fenêtre n'existe ».
     */
    reconciled: RemoteFlags[] | null;
}

/**
 * Envelopes for `imapPath`, from `sinceUid + 1` onward (or exactly the most
 * recent `initialLimit` messages when `sinceUid` is null). Detecting a
 * `uidValidity` change against the cache and clearing it first is the caller's
 * job; this always fetches the mailbox as it currently is.
 *
 * The `estimatedTotal` given to `onProgress` is an upper bound from the UID
 * range: deleted messages leave gaps IMAP doesn't report ahead of time.
 *
 * Avec `reconcile`, la fenêtre déjà en cache est relue au passage, dans la même
 * boîte déjà ouverte : c'est ce qui rend la relève capable d'apprendre autre
 * chose que l'arrivée d'un message.
 */
export async function syncFolder({
    credentials,
    imapPath,
    sinceUid,
    initialLimit,
    reconcile = null,
    onTokenRefreshed,
    onProgress
}: SyncFolderOptions): Promise<FolderSyncResult> {
    const auth = await resolveAuth(credentials, onTokenRefreshed);
    return withMailbox(auth, imapPath, async (client) => {
        const box = requireMailbox(client);
        const messages: RemoteEnvelope[] = [];
        if (box.exists > 0 && sinceUid !== null) {
            // Incremental: new mail always lands on a higher UID than anything
            // we hold, so an open-ended UID range is both correct and cheap.
            const estimatedTotal = Math.max(1, box.uidNext - 1 - sinceUid);
            for await (const msg of client.fetch(`${sinceUid + 1}:*`, FETCH_QUERY, { uid: true })) {
                // `n:*` always yields at least one message, even when every UID
                // is below `n`; drop anything we already have.
                if (msg.uid <= sinceUid) continue;
                messages.push(mapFetchedMessage(msg));
                onProgress?.(messages.length, estimatedTotal);
            }
        } else if (box.exists > 0) {
            // First sync, addressed by *sequence number*, which counts messages.
            // The UID equivalent (`uidNext - initialLimit`) is a window of UID
            // values, sparse wherever mail was ever deleted or moved, and would
            // hold a handful of messages instead of `initialLimit`.
            const firstSeq = Math.max(1, box.exists - initialLimit + 1);
            const estimatedTotal = box.exists - firstSeq + 1;
            for await (const msg of client.fetch(`${firstSeq}:${box.exists}`, FETCH_QUERY)) {
                messages.push(mapFetchedMessage(msg));
                onProgress?.(messages.length, estimatedTotal);
            }
        }

        // Sans recouvrement avec le fetch avant : la fenêtre à réconcilier est
        // par construction sous `sinceUid`, donc `onProgress` ne compte toujours
        // que les nouveaux messages.
        let reconciled: RemoteFlags[] | null = null;
        if (reconcile) {
            // Une boîte vidée côté serveur ne rend rien : c'est une réponse, pas
            // une absence de réponse, et le cache doit se vider avec elle.
            reconciled = [];
            if (box.exists > 0) {
                // Une plage `a:b` ne rend que les UID qui existent encore
                // (contrairement à `n:*`) : les absents de la réponse sont
                // exactement ceux que le serveur n'a plus.
                for await (const msg of client.fetch(`${reconcile.fromUid}:${reconcile.toUid}`, FLAGS_QUERY, {
                    uid: true
                })) {
                    const flags = msg.flags ?? new Set<string>();
                    reconciled.push({
                        uid: msg.uid,
                        seen: flags.has('\\Seen'),
                        flagged: flags.has('\\Flagged'),
                        answered: flags.has('\\Answered')
                    });
                }
            }
        }

        return { uidValidity: Number(box.uidValidity), messages, reconciled };
    });
}

export interface OlderMessagesResult {
    messages: RemoteEnvelope[];
    /** True once the fetched range reaches UID 1 — there's nothing older left to backfill. */
    reachedStart: boolean;
}

/**
 * Exactly the `limit` newest messages older than `beforeUid` (exclusive), the
 * backward counterpart to `syncFolder`'s forward-only fetch. `limit` counts
 * messages, not UID values; the two are only ever equal in a mailbox nothing
 * was deleted from. `reachedStart` is true once nothing older remains.
 */
export async function fetchOlderMessages(
    credentials: MailCredentials,
    imapPath: string,
    beforeUid: number | null,
    limit: number,
    onTokenRefreshed?: TokenRefreshCallback
): Promise<OlderMessagesResult> {
    const auth = await resolveAuth(credentials, onTokenRefreshed);
    return withMailbox(auth, imapPath, async (client) => {
        const box = requireMailbox(client);
        const upperBound = (beforeUid ?? box.uidNext) - 1;
        if (box.exists === 0 || upperBound < 1) return { messages: [], reachedStart: true };

        // Ask the server which UIDs actually exist below the boundary instead
        // of assuming the range is dense: a window of `limit` UID *values* holds
        // fewer messages wherever mail was deleted, often none, and an empty
        // batch would read as "nothing older left".
        const older = await client.search({ uid: `1:${upperBound}` }, { uid: true });
        if (!older || older.length === 0) return { messages: [], reachedStart: true };

        // `older` is ascending: its tail is the batch that continues the cache
        // downwards, and every existing UID between its ends is in it too, so a
        // range addresses it exactly.
        const batch = older.slice(-limit);
        const messages: RemoteEnvelope[] = [];
        for await (const msg of client.fetch(`${batch[0]}:${batch[batch.length - 1]}`, FETCH_QUERY, { uid: true })) {
            messages.push(mapFetchedMessage(msg));
        }
        return { messages, reachedStart: batch.length === older.length };
    });
}

/**
 * UIDs matching every one of `terms`, searched by the IMAP server itself, so
 * this reaches message bodies and messages that were never synced.
 *
 * One `SEARCH` per term, intersected, rather than a single query: IMAP ANDs
 * top-level search keys, and each term has to be an OR across the fields, so
 * "all terms match, each one anywhere" is not expressible as one key set.
 * `BODY` rather than `TEXT` on purpose: `TEXT` also matches raw headers, so a
 * search would hit `Received:` chains and Message-IDs.
 */
export async function searchMessageUids(
    credentials: MailCredentials,
    imapPath: string,
    terms: string[],
    onTokenRefreshed?: TokenRefreshCallback
): Promise<number[]> {
    if (terms.length === 0) return [];
    const auth = await resolveAuth(credentials, onTokenRefreshed);
    return withMailbox(auth, imapPath, async (client) => {
        let hits: number[] | null = null;
        for (const term of terms) {
            const found = await client.search(
                { or: [{ subject: term }, { from: term }, { to: term }, { cc: term }, { body: term }] },
                { uid: true }
            );
            // imapflow answers `false` when the mailbox isn't selected or the
            // server refused the search: no result, not an empty result.
            if (found === false) throw new Error('Recherche refusée par le serveur IMAP');
            const current = new Set<number>(found);
            hits = hits === null ? found : hits.filter((uid) => current.has(uid));
            if (hits.length === 0) break;
        }
        return hits ?? [];
    });
}

/** Envelopes for an explicit set of UIDs — the follow-up to a remote search, for hits absent from the cache. */
export async function fetchEnvelopesByUids(
    credentials: MailCredentials,
    imapPath: string,
    uids: number[],
    onTokenRefreshed?: TokenRefreshCallback
): Promise<RemoteEnvelope[]> {
    if (uids.length === 0) return [];
    const auth = await resolveAuth(credentials, onTokenRefreshed);
    return withMailbox(auth, imapPath, async (client) => {
        const messages: RemoteEnvelope[] = [];
        for await (const msg of client.fetch(uids.join(','), FETCH_QUERY, { uid: true })) {
            messages.push(mapFetchedMessage(msg));
        }
        return messages;
    });
}

/** Raw RFC822 source of one message, for MIME parsing by the caller. */
export async function fetchMessageRaw(
    credentials: MailCredentials,
    imapPath: string,
    uid: number,
    onTokenRefreshed?: TokenRefreshCallback
): Promise<Buffer> {
    const auth = await resolveAuth(credentials, onTokenRefreshed);
    return withMailbox(auth, imapPath, async (client) => {
        const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
        if (!msg || !msg.source) throw new Error('Message introuvable');
        return msg.source;
    });
}

export async function setFlags(
    credentials: MailCredentials,
    imapPath: string,
    uid: number,
    flags: { seen?: boolean; flagged?: boolean; answered?: boolean },
    onTokenRefreshed?: TokenRefreshCallback
): Promise<void> {
    const auth = await resolveAuth(credentials, onTokenRefreshed);
    await withMailbox(auth, imapPath, async (client) => {
        const add: string[] = [];
        const remove: string[] = [];
        if (flags.seen !== undefined) (flags.seen ? add : remove).push('\\Seen');
        if (flags.flagged !== undefined) (flags.flagged ? add : remove).push('\\Flagged');
        if (flags.answered !== undefined) (flags.answered ? add : remove).push('\\Answered');
        if (add.length > 0) await client.messageFlagsAdd(String(uid), add, { uid: true });
        if (remove.length > 0) await client.messageFlagsRemove(String(uid), remove, { uid: true });
    });
}

export async function moveMessage(
    credentials: MailCredentials,
    fromPath: string,
    uid: number,
    toPath: string,
    onTokenRefreshed?: TokenRefreshCallback
): Promise<number> {
    const auth = await resolveAuth(credentials, onTokenRefreshed);
    return withMailbox(auth, fromPath, async (client) => {
        const res = await client.messageMove(String(uid), toPath, { uid: true });
        if (!res) throw new Error('Déplacement impossible');
        return res.uidMap?.get(uid) ?? uid;
    });
}

/** Hard delete (mark `\Deleted` + expunge) — the caller decides move-to-Trash vs this. */
export async function deleteMessage(
    credentials: MailCredentials,
    imapPath: string,
    uid: number,
    onTokenRefreshed?: TokenRefreshCallback
): Promise<void> {
    const auth = await resolveAuth(credentials, onTokenRefreshed);
    await withMailbox(auth, imapPath, async (client) => {
        await client.messageFlagsAdd(String(uid), ['\\Deleted'], { uid: true });
        await client.messageDelete(String(uid), { uid: true });
    });
}

export interface OutgoingMail {
    from: string;
    to: MailAddress[];
    cc?: MailAddress[];
    bcc?: MailAddress[];
    subject: string;
    text: string;
    html?: string | null;
    attachments?: { filename: string; contentType: string; content: Buffer }[];
    inReplyTo?: string | null;
}

function addr(a: MailAddress): string {
    return a.name ? `"${a.name.replace(/"/g, '')}" <${a.address}>` : a.address;
}

export async function sendMail(
    credentials: MailCredentials,
    message: OutgoingMail,
    onTokenRefreshed?: TokenRefreshCallback
): Promise<{ messageId: string }> {
    const auth = await resolveAuth(credentials, onTokenRefreshed);
    const transport = await smtpTransport(auth);
    try {
        const info = await transport.sendMail({
            from: message.from,
            to: message.to.map(addr),
            cc: message.cc?.map(addr),
            bcc: message.bcc?.map(addr),
            subject: message.subject,
            text: message.text,
            html: message.html ?? undefined,
            attachments: message.attachments,
            inReplyTo: message.inReplyTo ?? undefined
        });
        return { messageId: info.messageId };
    } catch (e) {
        throw new Error(`Envoi du mail impossible : ${e instanceof Error ? e.message : String(e)}`);
    } finally {
        transport.close();
    }
}
