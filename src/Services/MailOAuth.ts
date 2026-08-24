import type { MailOAuthProvider } from '@deveye/types';
import { env } from '@/Utils/Env';

/**
 * OAuth2 authorization-code flow for Gmail/Microsoft 365 mailboxes, used to
 * obtain the tokens that let {@link MailAccountClient} authenticate to
 * standard IMAP/SMTP via SASL XOAUTH2 — no Gmail API / Graph API involved, so
 * the rest of the app has exactly one code path for every account regardless
 * of auth method. Entirely optional per provider: with no client id/secret
 * configured, `isConfigured` is false and the caller hides that provider's
 * "Connect with..." option rather than erroring.
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

function redirectUri(): string {
    return `${env.PUBLIC_ORIGIN}/api/mail/oauth/callback`;
}

export function buildAuthorizationUrl(provider: MailOAuthProvider, state: string): string {
    const c = providerConfig(provider);
    if (!c.clientId) throw new Error(`OAuth ${provider} is not configured on this server`);
    const params = new URLSearchParams({
        client_id: c.clientId,
        redirect_uri: redirectUri(),
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
    expires_in: number;
    scope?: string;
    id_token?: string;
    error?: string;
    error_description?: string;
}

/**
 * Pull the `email` claim out of the id_token. Not signature-verified: the
 * token just arrived directly from the provider's token endpoint over a
 * TLS + client-secret-authenticated request, which already establishes trust
 * — this is only reading a claim out of a response we already trust, not
 * accepting a bearer token from an untrusted party.
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

async function postToken(tokenUrl: string, body: URLSearchParams): Promise<TokenResponse> {
    const res = await fetch(tokenUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        signal: AbortSignal.timeout(10_000)
    });
    const json = (await res.json()) as TokenResponse;
    if (!res.ok || !json.access_token) {
        throw new Error(json.error_description || json.error || `Token request failed (${res.status})`);
    }
    return json;
}

/** Exchange an authorization code for the first access/refresh token pair. */
export async function exchangeCodeForTokens(provider: MailOAuthProvider, code: string): Promise<OAuthTokens> {
    const c = providerConfig(provider);
    if (!c.clientId || !c.clientSecret) throw new Error(`OAuth ${provider} is not configured on this server`);
    const json = await postToken(
        c.tokenUrl,
        new URLSearchParams({
            client_id: c.clientId,
            client_secret: c.clientSecret,
            code,
            redirect_uri: redirectUri(),
            grant_type: 'authorization_code'
        })
    );
    const email = emailFromIdToken(json.id_token);
    if (!email) throw new Error('Impossible de lire l’adresse mail depuis la réponse du fournisseur');
    return {
        accessToken: json.access_token,
        refreshToken: json.refresh_token ?? null,
        expiresAt: Date.now() + json.expires_in * 1000,
        scope: json.scope ?? c.scope,
        email
    };
}

/** Mint a fresh access token from a stored refresh token. */
export async function refreshAccessToken(
    provider: MailOAuthProvider,
    refreshToken: string
): Promise<{ accessToken: string; expiresAt: number }> {
    const c = providerConfig(provider);
    if (!c.clientId || !c.clientSecret) throw new Error(`OAuth ${provider} is not configured on this server`);
    const json = await postToken(
        c.tokenUrl,
        new URLSearchParams({
            client_id: c.clientId,
            client_secret: c.clientSecret,
            refresh_token: refreshToken,
            grant_type: 'refresh_token'
        })
    );
    return { accessToken: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 };
}
