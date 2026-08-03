import type { FastifyInstance } from 'fastify';
import { MAIL_SYNC_INTERVAL_DEFAULT_MINUTES } from 'deveye-types';
import type { MailOAuthCredentials } from '@/Services/MailAccountClient';
import { exchangeCodeForTokens } from '@/Services/MailOAuth';
import { verifyMailOAuthState } from '@/auth/jwt';
import { cipherForTier, encryptCredentials } from '@/features/mail/_shared';
import type { AuditLog } from '@/Services/AuditLog';
import { env } from '@/Utils/Env';
import type Encryption from '@/Services/Encryption';

import type { Database } from '@/db';

interface MailOAuthRouteDeps {
    db: Database;
    crypt: Encryption;
    audit: AuditLog;
}

/**
 * The single OAuth redirect target for Gmail/Microsoft 365 mailboxes
 * (`mail.oauthStart` builds the authorization URL pointing here). Opened in a
 * popup by the client; this always responds with a small self-closing HTML
 * page rather than a redirect, since there's no natural place in the SPA to
 * land on mid-flow — `window.opener.postMessage` is how the popup reports
 * back, matching a standard OAuth-popup pattern.
 */
function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * `message` is never trustworthy: on the error path it is `?error=` straight
 * off the query string, so this page is reachable with arbitrary content on
 * DevEye's own origin. It goes into markup escaped, and into the script block
 * as JSON with `<` neutralised — `JSON.stringify` alone leaves `</script>`
 * intact, which is enough to break out of the block.
 */
function popupResponse(ok: boolean, message?: string): string {
    const payload = JSON.stringify({ source: 'deveye-mail-oauth', ok, error: message ?? null }).replace(
        /</g,
        '\\u003c'
    );
    const originJson = JSON.stringify(env.PUBLIC_ORIGIN).replace(/</g, '\\u003c');
    const text = ok
        ? 'Compte connecté — vous pouvez fermer cette fenêtre.'
        : `Échec de la connexion : ${escapeHtml(message ?? 'inconnu')}`;
    return `<!doctype html><html><head><meta charset="utf-8"><title>DevEye Mail</title></head>
<body style="font-family:sans-serif;padding:2rem;color:#333">
<p>${text}</p>
<script>
  if (window.opener) { window.opener.postMessage(${payload}, ${originJson}); }
  window.close();
</script>
</body></html>`;
}

export async function mailOAuthRoutes(app: FastifyInstance, { db, crypt, audit }: MailOAuthRouteDeps): Promise<void> {
    app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
        '/api/mail/oauth/callback',
        async (req, reply) => {
            reply.type('text/html');
            const { code, state, error } = req.query;

            if (error) return reply.send(popupResponse(false, error));
            if (!code || !state) return reply.send(popupResponse(false, 'Réponse incomplète du fournisseur'));

            const claims = await verifyMailOAuthState(state);
            if (!claims) return reply.send(popupResponse(false, 'Lien de connexion expiré ou invalide'));

            try {
                const tokens = await exchangeCodeForTokens(claims.provider, code);
                const credentials: MailOAuthCredentials = {
                    kind: 'oauth',
                    provider: claims.provider,
                    email: tokens.email,
                    accessToken: tokens.accessToken,
                    refreshToken: tokens.refreshToken,
                    expiresAt: tokens.expiresAt,
                    // Set afterwards from the account form if the user wants one.
                    proxy: null
                };

                const cipher = cipherForTier(db, crypt, claims.userId, claims.sessionId, claims.securityTier);

                const account = await db.mailAccounts.create({
                    userId: claims.userId,
                    displayNameEnc: await cipher.encrypt(tokens.email),
                    emailAddressEnc: await cipher.encrypt(tokens.email),
                    securityTier: claims.securityTier,
                    authMethod: claims.provider === 'google' ? 'oauth_google' : 'oauth_microsoft',
                    credentialsEnc: await encryptCredentials(cipher, credentials),
                    enabled: true,
                    syncIntervalSeconds: MAIL_SYNC_INTERVAL_DEFAULT_MINUTES * 60
                });

                audit.record({
                    source: 'web',
                    category: 'mail',
                    action: 'mail.oauthConnect',
                    uid: claims.userId,
                    ip: req.ip,
                    description: `Compte mail connecté via ${claims.provider === 'google' ? 'Google' : 'Microsoft'}`,
                    metadata: { accountId: account.id, provider: claims.provider }
                });

                return reply.send(popupResponse(true));
            } catch (e) {
                const message = e instanceof Error ? e.message : String(e);
                req.log.error({ err: message }, 'Mail OAuth callback failed');
                return reply.send(popupResponse(false, message));
            }
        }
    );
}
