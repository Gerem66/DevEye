import { z } from 'zod';

import {
    MAIL_SYNC_INTERVAL_DEFAULT_MINUTES,
    mailOAuthProviderSchema,
    mailSecurityTierSchema,
    type MailAccountRow,
    type MailSecurityTier
} from '../contracts/domain';
import type { FeatureServiceDeps, SdkCipher, SdkPublicApp, SdkRedeemedTicket } from '@deveye/types/sdk/server';

import * as mailClient from './client';
import type { MailOAuthCredentials } from './client';
import * as mailOAuth from './oauth';
import { findAttachmentBytes } from './parse';
import type { MailRepo } from './repo';
import { decryptCredentials, encryptCredentials, persistRefreshedToken, tryDecryptCredentials } from './_shared';

/**
 * Les deux portes HTTP de Mail, sur la surface publique du SDK (capacité
 * `routes.public`, `exposure: 'app'` : l'origine de l'app seulement). Toutes
 * deux sont des GET nus, sans session : le navigateur télécharge nativement, la
 * fenêtre de consentement revient de chez Google ou Microsoft. Ce qui les
 * autorise est un ticket de session signé par l'hôte (`deps.secrecy.redeem`) :
 * il lie l'appelant, son espace et ce module, et se rend contre ses codecs,
 * l'étage gardé compris tant que sa session est déverrouillée.
 */

export type MailRouteDeps = Pick<
    FeatureServiceDeps<MailRepo>,
    'repo' | 'secrecy' | 'cipherFor' | 'origins' | 'logger' | 'audit'
>;

/**
 * La couture de test des routes : le client IMAP et l'échange OAuth, sans
 * réseau. Le reste, tickets compris, tourne tel quel.
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
    securityTier: mailSecurityTierSchema,
    /** Le nom saisi au formulaire. Vide : le compte prend son adresse. */
    displayName: z.string().default(''),
    /**
     * La boîte à renouveler, déjà vérifiée par `mail.oauthStart` (existence,
     * domicile, méthode) : le ticket est signé, cet identifiant ne se falsifie
     * pas. `null` pour une création.
     */
    accountId: z.number().int().positive().nullable().default(null)
});

const attachmentQuerySchema = z.object({ token: z.string().min(1) });
const oauthQuerySchema = z.object({
    code: z.string().optional(),
    state: z.string().optional(),
    error: z.string().optional()
});

/**
 * Le codec d'un compte visible depuis l'espace du ticket : l'étage ouvert de son
 * domicile pour un compte ouvert (jamais celui du ticket, qui ne lirait pas une
 * boîte projetée), l'étage gardé du ticket pour un compte gardé, qui ne se
 * projette pas. `null` quand la session s'est verrouillée entre l'émission du
 * ticket et son usage.
 */
function ticketAccountCipher(
    deps: MailRouteDeps,
    ticket: SdkRedeemedTicket,
    account: MailAccountRow
): SdkCipher | null {
    return account.security_tier === 'open' ? deps.cipherFor(account.workspace_id) : ticket.cipher.private;
}

/** Le codec du palier qu'un consentement OAuth va créer, sous l'espace du ticket. */
function ticketCipher(ticket: SdkRedeemedTicket, tier: MailSecurityTier): SdkCipher | null {
    return tier === 'open' ? ticket.cipher.server : ticket.cipher.private;
}

/**
 * `Content-Disposition` for a filename that came out of an untrusted email. The
 * plain `filename=` form is reduced to safe ASCII (a newline especially, which
 * Node rejects outright, turning a download into a 500); the real name rides in
 * the RFC 5987 `filename*` form, which browsers prefer when both are present.
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

/** L'adresse du script de la popup, servi comme fichier par la route ci-dessous. */
const POPUP_SCRIPT_PATH = '/api/mail/oauth/close.js';

/**
 * Ce que la popup exécute : lire son verdict sur `<body>`, le poster à l'origine
 * qui a servi la page (celle de l'app, puisque c'est là que le fournisseur
 * redirige), puis se fermer.
 *
 * Servi comme fichier et non écrit dans la page : la politique de contenu de
 * l'app (`script-src 'self'`) le couvre alors telle quelle. Un script inline
 * aurait demandé à cette page une politique à elle, calculée sur les octets du
 * script : une ligne changée sans toucher à l'en-tête, et la popup ne se fermait
 * plus, en silence.
 */
const POPUP_SCRIPT = `(function () {
    var verdict = document.body.dataset;
    if (window.opener) {
        window.opener.postMessage(
            { source: 'deveye-mail-oauth', ok: verdict.ok === 'true', error: verdict.error || null },
            window.location.origin
        );
    }
    window.close();
})();
`;

/**
 * The single OAuth redirect target for Gmail/Microsoft 365 mailboxes. Opened in
 * a popup by the client; it always answers with a small self-closing HTML page
 * rather than a redirect, `window.opener.postMessage` being how the popup
 * reports back.
 *
 * `message` is never trustworthy: on the error path it is `?error=` straight off
 * the query string, so this page is reachable with arbitrary content on DevEye's
 * own origin. Il n'y traverse qu'échappé, en texte et en attribut ; la page ne
 * porte aucun script où il pourrait se glisser.
 */
export function popupResponse(ok: boolean, message?: string): string {
    const text = ok
        ? 'Compte connecté, vous pouvez fermer cette fenêtre.'
        : `Échec de la connexion : ${escapeHtml(message ?? 'inconnu')}`;
    return `<!doctype html><html><head><meta charset="utf-8"><title>DevEye Mail</title></head>
<body style="font-family:sans-serif;padding:2rem;color:#333" data-ok="${ok}" data-error="${escapeHtml(message ?? '')}">
<p>${text}</p>
<script src="${POPUP_SCRIPT_PATH}"></script>
</body></html>`;
}

export function mailRoutes(app: SdkPublicApp, deps: MailRouteDeps, seam: MailRouteSeam = {}): void {
    const client = seam.client ?? mailClient;
    const oauth = seam.oauth ?? mailOAuth;

    /**
     * Streams one attachment's bytes, re-derived live from IMAP (never cached
     * server-side, matching the rest of Mail's storage policy). Reached via the
     * short-lived ticketed URL `mail.attachmentDownload` hands back, a plain GET
     * so the browser's native download flow just works.
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
        // Visible depuis l'espace du ticket : chez lui, ou projeté là. La pièce
        // d'un compte projeté se sert comme son message se lit.
        const account = await deps.repo.accounts.findVisible(folder.account_id, ticket.workspaceId);
        if (!account) return reply.code(404).send({ error: 'not_found' });

        // Un compte gardé dont la session s'est verrouillée entre-temps : le
        // même refus qu'une commande, sans rien tenter.
        const cipher = ticketAccountCipher(deps, ticket, account);
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

    // Le script de la page ci-dessous. Une route plutôt qu'un fichier statique :
    // elle est servie par le même écouteur en développement comme en production,
    // où le client n'est pas monté de la même façon.
    app.get(POPUP_SCRIPT_PATH, { exposure: 'app' }, async (_req, reply) => {
        reply.header('Content-Type', 'application/javascript; charset=utf-8');
        return reply.send(POPUP_SCRIPT);
    });

    app.get('/api/mail/oauth/callback', { exposure: 'app' }, async (req, reply) => {
        reply.header('Content-Type', 'text/html; charset=utf-8');
        const page = (ok: boolean, message?: string) => reply.send(popupResponse(ok, message));
        const query = oauthQuerySchema.safeParse(req.query);
        const { code, state, error } = query.success ? query.data : {};

        if (error) return page(false, error);
        if (!code || !state) return page(false, 'Réponse incomplète du fournisseur');

        const ticket = await deps.secrecy.redeem(state);
        const claims = ticket ? oauthStateSchema.safeParse(ticket.payload) : null;
        if (!ticket || !claims?.success) return page(false, 'Lien de connexion expiré ou invalide');

        // Le palier a été vérifié à l'émission du ticket (`mail.oauthStart`) ;
        // ici il reste à tenir le codec, un compte gardé exigeant que la session
        // le soit encore.
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

            const provider = claims.data.provider === 'google' ? 'Google' : 'Microsoft';
            const authMethod =
                claims.data.provider === 'google' ? ('oauth_google' as const) : ('oauth_microsoft' as const);

            if (claims.data.accountId !== null) {
                const existing = await deps.repo.accounts.findById(claims.data.accountId, ticket.workspaceId);
                if (!existing) return page(false, 'Boîte introuvable : elle a pu être supprimée entre-temps');
                // L'adresse consentie doit être celle de la boîte : sans ce contrôle,
                // se tromper de compte chez le fournisseur écraserait les jetons
                // d'une boîte par ceux d'une autre, dont elle porterait le nom.
                const known = await cipher.tryDecrypt(existing.email_address_enc);
                if (known !== null && known.toLowerCase() !== tokens.email.toLowerCase()) {
                    return page(false, `Ce consentement porte sur ${tokens.email}, pas sur ${known}`);
                }
                // Le proxy, et le jeton de rafraîchissement quand le
                // fournisseur n'en rend pas un neuf, appartiennent à la boîte :
                // l'écran de consentement ne les redemande pas, les écraser les
                // perd. Lecture tolérante, un blob illisible ne devant pas faire
                // échouer une reconnexion.
                const previous = await tryDecryptCredentials(cipher, existing.credentials_enc);
                const reconnected: MailOAuthCredentials = {
                    ...credentials,
                    refreshToken: tokens.refreshToken ?? (previous?.kind === 'oauth' ? previous.refreshToken : null),
                    proxy: previous?.proxy ?? null
                };
                await deps.repo.accounts.update(existing.id, ticket.workspaceId, {
                    displayNameEnc: existing.display_name_enc,
                    emailAddressEnc: existing.email_address_enc,
                    securityTier: existing.security_tier,
                    authMethod,
                    credentialsEnc: await encryptCredentials(cipher, reconnected),
                    enabled: existing.enabled === 1,
                    syncIntervalSeconds: existing.sync_interval_seconds
                });
                // L'état d'erreur ne survit pas au renouvellement : le laisser
                // ferait dire à la boîte qu'elle est toujours refusée.
                await deps.repo.accounts.recordStatus(existing.id, Math.floor(Date.now() / 1000), null, 'ok');
                deps.audit({
                    action: 'mail.oauthReconnect',
                    userId: ticket.userId,
                    description: `Compte mail reconnecté via ${provider}`,
                    metadata: {
                        accountId: existing.id,
                        provider: claims.data.provider,
                        workspaceId: ticket.workspaceId
                    }
                });
                return page(true);
            }

            const account = await deps.repo.accounts.create({
                userId: ticket.userId,
                workspaceId: ticket.workspaceId,
                displayNameEnc: await cipher.encrypt(claims.data.displayName || tokens.email),
                emailAddressEnc: await cipher.encrypt(tokens.email),
                securityTier: claims.data.securityTier,
                authMethod,
                credentialsEnc: await encryptCredentials(cipher, credentials),
                enabled: true,
                syncIntervalSeconds: MAIL_SYNC_INTERVAL_DEFAULT_MINUTES * 60
            });

            deps.audit({
                action: 'mail.oauthConnect',
                userId: ticket.userId,
                description: `Compte mail connecté via ${provider}`,
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
