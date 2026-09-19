import type { MailOAuthProvider } from '../contracts/domain';
import { env } from './env';

/**
 * OAuth2 authorization-code flow for Gmail/Microsoft 365 mailboxes, to obtain
 * the tokens that let `client.ts` authenticate to standard IMAP/SMTP via SASL
 * XOAUTH2, no Gmail API / Graph API involved. Entirely optional per provider:
 * with no client id/secret configured, `isOAuthConfigured` is false and the
 * caller hides that provider's "Connect with..." option rather than erroring.
 */

interface ProviderConfig {
    authUrl: string;
    tokenUrl: string;
    scope: string;
    clientId: string | undefined;
    clientSecret: string | undefined;
    /** IMAP/SMTP endpoints XOAUTH2 tokens for this provider are valid against. */
    imapHost: string;
    imapPort: number;
    smtpHost: string;
    smtpPort: number;
}

function providerConfig(provider: MailOAuthProvider): ProviderConfig {
    switch (provider) {
        case 'google':
            return {
                authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
                tokenUrl: 'https://oauth2.googleapis.com/token',
                // Full-mailbox IMAP/SMTP scope (not the narrower Gmail API scopes,
                // which don't grant XOAUTH2 over standard IMAP/SMTP) + openid/email
                // so the id_token carries the address without a second API call.
                scope: 'https://mail.google.com/ openid email',
                clientId: env.OAUTH_GOOGLE_CLIENT_ID,
                clientSecret: env.OAUTH_GOOGLE_CLIENT_SECRET,
                imapHost: 'imap.gmail.com',
                imapPort: 993,
                smtpHost: 'smtp.gmail.com',
                smtpPort: 465
            };
        case 'microsoft':
            return {
                authUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
                tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
                scope: 'offline_access openid email https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send',
                clientId: env.OAUTH_MICROSOFT_CLIENT_ID,
                clientSecret: env.OAUTH_MICROSOFT_CLIENT_SECRET,
                imapHost: 'outlook.office365.com',
                imapPort: 993,
                smtpHost: 'smtp.office365.com',
                smtpPort: 587
            };
    }
}

export function isOAuthConfigured(provider: MailOAuthProvider): boolean {
    const c = providerConfig(provider);
    return Boolean(c.clientId && c.clientSecret);
}

/** Default server endpoints an OAuth account of this provider connects to. */
export function oauthProviderEndpoints(provider: MailOAuthProvider) {
    const c = providerConfig(provider);
    return { imapHost: c.imapHost, imapPort: c.imapPort, smtpHost: c.smtpHost, smtpPort: c.smtpPort };
}

/**
 * Le retour du consentement : la route publique du module, sur l'origine de
 * l'app. La même adresse doit être donnée à l'autorisation et à l'échange du
 * code, le fournisseur refusant un échange dont le `redirect_uri` ne redit pas
 * celui de l'autorisation.
 */
function redirectUri(appOrigin: string): string {
    return `${appOrigin}/api/mail/oauth/callback`;
}

export function buildAuthorizationUrl(provider: MailOAuthProvider, state: string, appOrigin: string): string {
    const c = providerConfig(provider);
    if (!c.clientId) throw new Error(`OAuth ${provider} is not configured on this server`);
    const params = new URLSearchParams({
        client_id: c.clientId,
        redirect_uri: redirectUri(appOrigin),
        response_type: 'code',
        scope: c.scope,
        state,
        access_type: 'offline',
        prompt: 'consent'
    });
    return `${c.authUrl}?${params.toString()}`;
}

export interface OAuthTokens {
    accessToken: string;
    /** Absent when the provider didn't return one (e.g. a repeated consent without `prompt=consent`). */
    refreshToken: string | null;
    /** Epoch ms. */
    expiresAt: number;
    scope: string;
    /** Mailbox address, read from the `id_token` (openid/email scope) — no extra API call. */
    email: string;
}

interface TokenResponse {
    access_token: string;
    refresh_token?: string;
    /** Unvalidated: the provider's response is parsed, never type-checked. */
    expires_in?: unknown;
    scope?: string;
    id_token?: string;
    error?: string;
    error_description?: string;
}

/**
 * The only refusals that are final (RFC 6749 §5.2): consent withdrawn or token
 * revoked, client secret changed, client or scope no longer allowed. Anything
 * else is treated as transient, a false "reconnect this mailbox" costing more
 * than a lost sync round.
 */
const PERMANENT_TOKEN_ERRORS = new Set(['invalid_grant', 'invalid_client', 'unauthorized_client', 'invalid_scope']);

/**
 * A refusal from the token endpoint, carrying what it takes to decide: `code`
 * is the response's `error` field when it had one, `status` the HTTP status,
 * and `permanent` says only a fresh consent gets the mailbox back. The verdict
 * reads the OAuth code and never the HTTP status: Google answers 400 for
 * `invalid_grant` as it does for `rate_limit_exceeded`.
 */
export class OAuthTokenError extends Error {
    readonly permanent: boolean;

    constructor(
        readonly provider: MailOAuthProvider,
        readonly status: number | null,
        readonly code: string | null,
        message: string,
        cause?: unknown
    ) {
        super(message);
        this.name = 'OAuthTokenError';
        this.permanent = code !== null && PERMANENT_TOKEN_ERRORS.has(code);
        if (cause !== undefined) this.cause = cause;
    }
}

/** What both providers return anyway; the fallback when the field is unusable. */
const DEFAULT_EXPIRES_IN_SECONDS = 3600;

/**
 * A missing or unreadable `expires_in` would yield `NaN`, and since
 * `Date.now() >= NaN` is always false, the token would never be refreshed again.
 */
function expiresAtFrom(raw: unknown): number {
    const seconds = Number(raw);
    return Date.now() + (Number.isFinite(seconds) && seconds > 0 ? seconds : DEFAULT_EXPIRES_IN_SECONDS) * 1000;
}

/**
 * Pull the `email` claim out of the id_token. Not signature-verified: the token
 * just arrived from the provider's token endpoint over a TLS +
 * client-secret-authenticated request, so this reads a claim out of a response
 * already trusted, not a bearer token from an untrusted party.
 */
function emailFromIdToken(idToken: string | undefined): string | null {
    if (!idToken) return null;
    const parts = idToken.split('.');
    if (parts.length !== 3) return null;
    try {
        const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as { email?: string };
        return typeof payload.email === 'string' ? payload.email : null;
    } catch {
        return null;
    }
}

async function postToken(provider: MailOAuthProvider, tokenUrl: string, body: URLSearchParams): Promise<TokenResponse> {
    let res: Response;
    let text: string;
    try {
        res = await fetch(tokenUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: body.toString(),
            signal: AbortSignal.timeout(10_000)
        });
        // Read as text first: a broken gateway answers HTML, and `res.json()`
        // would throw a SyntaxError that loses both status and OAuth code.
        text = await res.text();
    } catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        throw new OAuthTokenError(provider, null, null, `Token endpoint unreachable (${provider}): ${detail}`, e);
    }

    let json: TokenResponse | null;
    try {
        json = JSON.parse(text) as TokenResponse;
    } catch {
        json = null;
    }

    if (!res.ok || !json?.access_token) {
        const code = typeof json?.error === 'string' ? json.error : null;
        // Truncated: a verbose HTML body ends up in `last_sync_error_enc`.
        const detail = json?.error_description ?? (json === null ? text.slice(0, 200).trim() : null);
        throw new OAuthTokenError(
            provider,
            res.status,
            code,
            `Token endpoint (${provider}) answered ${res.status}` +
                (code ? ` (${code})` : '') +
                (detail ? `: ${detail}` : '')
        );
    }
    return json;
}

/** Exchange an authorization code for the first access/refresh token pair. */
export async function exchangeCodeForTokens(
    provider: MailOAuthProvider,
    code: string,
    appOrigin: string
): Promise<OAuthTokens> {
    const c = providerConfig(provider);
    if (!c.clientId || !c.clientSecret) throw new Error(`OAuth ${provider} is not configured on this server`);
    const json = await postToken(
        provider,
        c.tokenUrl,
        new URLSearchParams({
            client_id: c.clientId,
            client_secret: c.clientSecret,
            code,
            redirect_uri: redirectUri(appOrigin),
            grant_type: 'authorization_code'
        })
    );
    const email = emailFromIdToken(json.id_token);
    if (!email) throw new Error('Impossible de lire l’adresse mail depuis la réponse du fournisseur');
    return {
        accessToken: json.access_token,
        refreshToken: json.refresh_token ?? null,
        expiresAt: expiresAtFrom(json.expires_in),
        scope: json.scope ?? c.scope,
        email
    };
}

export interface RefreshedToken {
    accessToken: string;
    /** Epoch ms. */
    expiresAt: number;
    /** Returned when the provider rotates its refresh tokens (Microsoft); `null` otherwise. */
    refreshToken: string | null;
}

/**
 * Refreshes in flight, keyed by provider and token: the background sync and a
 * "Sync now" click set off with the same refresh token, and two concurrent
 * POSTs invalidate one of them wherever tokens rotate. The key holds a secret:
 * it never leaves this module and goes as soon as the promise settles.
 */
const inFlightRefresh = new Map<string, Promise<RefreshedToken>>();

/** Mint a fresh access token from a stored refresh token. */
export function refreshAccessToken(provider: MailOAuthProvider, refreshToken: string): Promise<RefreshedToken> {
    const key = `${provider}:${refreshToken}`;
    const running = inFlightRefresh.get(key);
    if (running) return running;
    const task = mintAccessToken(provider, refreshToken).finally(() => inFlightRefresh.delete(key));
    inFlightRefresh.set(key, task);
    return task;
}

async function mintAccessToken(provider: MailOAuthProvider, refreshToken: string): Promise<RefreshedToken> {
    const c = providerConfig(provider);
    if (!c.clientId || !c.clientSecret) throw new Error(`OAuth ${provider} is not configured on this server`);
    const json = await postToken(
        provider,
        c.tokenUrl,
        new URLSearchParams({
            client_id: c.clientId,
            client_secret: c.clientSecret,
            refresh_token: refreshToken,
            grant_type: 'refresh_token'
        })
    );
    return {
        accessToken: json.access_token,
        expiresAt: expiresAtFrom(json.expires_in),
        refreshToken: json.refresh_token ?? null
    };
}
