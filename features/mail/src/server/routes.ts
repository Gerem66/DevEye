import { z } from 'zod';

import {
    MAIL_SYNC_INTERVAL_DEFAULT_MINUTES,
    mailOAuthProviderSchema,
    mailSecurityTierSchema,
    type MailSecurityTier
} from '../contracts/domain';
import type { FeatureServiceDeps, SdkCipher, SdkPublicApp, SdkRedeemedTicket } from '@deveye/types/sdk/server';

import * as mailClient from './client';
import type { MailOAuthCredentials } from './client';
import * as mailOAuth from './oauth';
import { findAttachmentBytes } from './parse';
import type { MailRepo } from './repo';
import { decryptCredentials, encryptCredentials, persistRefreshedToken } from './_shared';

/**
 * Les deux portes HTTP de Mail, sur la surface publique du SDK (capacité
 * `routes.public`, `exposure: 'app'` : l'origine de l'app seulement, jamais le
 * second écouteur). Toutes deux sont des GET nus, sans session : le
 * navigateur télécharge nativement, la fenêtre de consentement revient de
 * chez Google ou Microsoft. Ce qui les autorise est un **ticket de session**
 * signé par l'hôte (`ctx.secrecy.ticket` côté commande, `deps.secrecy.redeem`
 * ici) : il lie l'appelant, son espace et ce module, et se rend contre ses
 * codecs, l'étage gardé compris tant que sa session est déverrouillée. Le
 * module ne voit ni session ni clé ; c'était l'ex `signMailAttachmentToken` /
 * `signMailOAuthState` de `auth/jwt.ts`, et `cipherForTier` qui reconstruisait
 * le magasin gardé à partir de l'identifiant de session.
 */

/** Ce que les routes lisent de l'hôte : le dépôt, le rendu des tickets, l'origine, le journal. */
export type MailRouteDeps = Pick<FeatureServiceDeps<MailRepo>, 'repo' | 'secrecy' | 'origins' | 'logger' | 'audit'>;

/**
 * La couture de test des routes : le client IMAP (les octets d'un message) et
 * l'échange OAuth (le code contre les jetons), sans réseau. Le reste, tickets
 * compris, tourne tel quel sur le harnais.
 */
export interface MailRouteSeam {
    client?: Pick<typeof mailClient, 'fetchMessageRaw'>;
    oauth?: Pick<typeof mailOAuth, 'exchangeCodeForTokens'>;
}

/** La charge d'un ticket de pièce jointe, telle que `mail.attachmentDownload` la pose. */
export const attachmentTicketSchema = z.object({
    messageId: z.number().int().positive(),
    attachmentId: z.string()
});

/** La charge du `state` OAuth, telle que `mail.oauthStart` la pose. */
export const oauthStateSchema = z.object({
    provider: mailOAuthProviderSchema,
    securityTier: mailSecurityTierSchema
});

const attachmentQuerySchema = z.object({ token: z.string().min(1) });
const oauthQuerySchema = z.object({
    code: z.string().optional(),
    state: z.string().optional(),
    error: z.string().optional()
});

/**
 * Le codec d'un compte, tiré du ticket rendu : l'étage ouvert pour un compte
 * ouvert, l'étage gardé pour un compte gardé, `null` quand la session s'est
 * verrouillée entre l'émission du ticket et son usage (le ticket vit deux
 * minutes, le verrou peut tomber entre-temps).
 */
function ticketCipher(ticket: SdkRedeemedTicket, tier: MailSecurityTier): SdkCipher | null {
    return tier === 'open' ? ticket.cipher.server : ticket.cipher.private;
}

/**
 * `Content-Disposition` for a filename that came out of an untrusted email.
 * The plain `filename=` form is reduced to safe ASCII — anything else (a
 * newline especially, which Node rejects outright and would turn a download
 * into a 500) is dropped — and the real name is carried by the RFC 5987
 * `filename*` form, which browsers prefer when both are present.
 */
export function contentDisposition(filename: string): string {
    const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '');
    const fallback = ascii.trim() || 'fichier';
    return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * The single OAuth redirect target for Gmail/Microsoft 365 mailboxes
 * (`mail.oauthStart` builds the authorization URL pointing here). Opened in a
 * popup by the client; this always responds with a small self-closing HTML
 * page rather than a redirect, since there's no natural place in the SPA to
 * land on mid-flow — `window.opener.postMessage` is how the popup reports
 * back, matching a standard OAuth-popup pattern.
 *
 * `message` is never trustworthy: on the error path it is `?error=` straight
 * off the query string, so this page is reachable with arbitrary content on
 * DevEye's own origin. It goes into markup escaped, and into the script block
 * as JSON with `<` neutralised — `JSON.stringify` alone leaves `</script>`
 * intact, which is enough to break out of the block.
 *
 * La cible du `postMessage` est l'origine de l'app (`deps.origins.app`, l'ex
 * `PUBLIC_ORIGIN`) : la fenêtre qui a ouvert le consentement, et aucune autre.
 */
export function popupResponse(appOrigin: string, ok: boolean, message?: string): string {
    const payload = JSON.stringify({ source: 'deveye-mail-oauth', ok, error: message ?? null }).replace(
        /</g,
        '\\u003c'
    );
    const originJson = JSON.stringify(appOrigin).replace(/</g, '\\u003c');
    const text = ok
        ? 'Compte connecté, vous pouvez fermer cette fenêtre.'
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

export function mailRoutes(app: SdkPublicApp, deps: MailRouteDeps, seam: MailRouteSeam = {}): void {
    const client = seam.client ?? mailClient;
    const oauth = seam.oauth ?? mailOAuth;

    /**
     * Streams one attachment's bytes, re-derived live from IMAP (never cached
     * server-side, matching the rest of Mail's storage policy). Reached via the
     * short-lived ticketed URL `mail.attachmentDownload` hands back — a plain GET
     * so the browser's native download flow (Content-Disposition) just works,
     * rather than piping bytes back over the WebSocket.
     */
    app.get('/api/mail/attachment', { exposure: 'app' }, async (req, reply) => {
        const query = attachmentQuerySchema.safeParse(req.query);
        if (!query.success) return reply.code(400).send({ error: 'missing_token' });
        const ticket = await deps.secrecy.redeem(query.data.token);
        const claims = ticket ? attachmentTicketSchema.safeParse(ticket.payload) : null;
        if (!ticket || !claims?.success) return reply.code(401).send({ error: 'invalid_token' });

        const message = await deps.repo.messages.findById(claims.data.messageId);
        if (!message) return reply.code(404).send({ error: 'not_found' });
        const folder = await deps.repo.folders.findById(message.folder_id);
        if (!folder) return reply.code(404).send({ error: 'not_found' });
        const account = await deps.repo.accounts.findById(folder.account_id, ticket.workspaceId);
        if (!account) return reply.code(404).send({ error: 'not_found' });

        // Un compte gardé dont la session s'est verrouillée entre-temps : le
        // même refus qu'une commande, sans rien tenter.
        const cipher = ticketCipher(ticket, account.security_tier);
        if (!cipher) return reply.code(401).send({ error: 'locked' });

        try {
            const credentials = await decryptCredentials(cipher, account.credentials_enc);
            const refresh = persistRefreshedToken(deps.repo, account.id, credentials, cipher);
            const raw = await client.fetchMessageRaw(credentials, folder.imap_path, message.uid, refresh);
            const attachment = await findAttachmentBytes(raw, claims.data.attachmentId);
            if (!attachment) return reply.code(404).send({ error: 'not_found' });

            reply.header('Content-Type', attachment.mimeType || 'application/octet-stream');
            reply.header('Content-Length', String(attachment.content.length));
            reply.header('Content-Disposition', contentDisposition(attachment.filename));
            return reply.send(attachment.content);
        } catch (e) {
            deps.logger.error({ err: e instanceof Error ? e.message : String(e) }, 'Mail attachment download failed');
            return reply.code(502).send({ error: 'fetch_failed' });
        }
    });

    app.get('/api/mail/oauth/callback', { exposure: 'app' }, async (req, reply) => {
        reply.header('Content-Type', 'text/html; charset=utf-8');
        const page = (ok: boolean, message?: string) => reply.send(popupResponse(deps.origins.app, ok, message));
        const query = oauthQuerySchema.safeParse(req.query);
        const { code, state, error } = query.success ? query.data : {};

        if (error) return page(false, error);
        if (!code || !state) return page(false, 'Réponse incomplète du fournisseur');

        const ticket = await deps.secrecy.redeem(state);
        const claims = ticket ? oauthStateSchema.safeParse(ticket.payload) : null;
        if (!ticket || !claims?.success) return page(false, 'Lien de connexion expiré ou invalide');

        // Le palier a été vérifié à l'émission du ticket (`assertTierAllowed`,
        // dans `mail.oauthStart`) ; ici il ne reste qu'à tenir le codec, et un
        // compte gardé exige que la session le soit encore.
        const cipher = ticketCipher(ticket, claims.data.securityTier);
        if (!cipher) return page(false, 'Session verrouillée entre-temps : déverrouillez puis recommencez');

        try {
            const tokens = await oauth.exchangeCodeForTokens(claims.data.provider, code, deps.origins.app);
            const credentials: MailOAuthCredentials = {
                kind: 'oauth',
                provider: claims.data.provider,
                email: tokens.email,
                accessToken: tokens.accessToken,
                refreshToken: tokens.refreshToken,
                expiresAt: tokens.expiresAt,
                // Set afterwards from the account form if the user wants one.
                proxy: null
            };

            const account = await deps.repo.accounts.create({
                userId: ticket.userId,
                workspaceId: ticket.workspaceId,
                displayNameEnc: await cipher.encrypt(tokens.email),
                emailAddressEnc: await cipher.encrypt(tokens.email),
                securityTier: claims.data.securityTier,
                authMethod: claims.data.provider === 'google' ? 'oauth_google' : 'oauth_microsoft',
                credentialsEnc: await encryptCredentials(cipher, credentials),
                enabled: true,
                syncIntervalSeconds: MAIL_SYNC_INTERVAL_DEFAULT_MINUTES * 60
            });

            deps.audit({
                action: 'mail.oauthConnect',
                userId: ticket.userId,
                description: `Compte mail connecté via ${claims.data.provider === 'google' ? 'Google' : 'Microsoft'}`,
                metadata: { accountId: account.id, provider: claims.data.provider, workspaceId: ticket.workspaceId }
            });

            return page(true);
        } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            deps.logger.error({ err: message }, 'Mail OAuth callback failed');
            return page(false, message);
        }
    });
}
