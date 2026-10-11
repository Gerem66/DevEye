import { z } from 'zod';

import type { MailAccountRow } from '../contracts/domain';
import {
    contentDisposition,
    logFailure,
    type FeatureServiceDeps,
    type SdkCipher,
    type SdkPublicApp,
    type SdkRedeemedTicket
} from '@deveye/types/sdk/server';

import * as mailClient from './client';
import { findAttachmentBytes } from './parse';
import type { MailRepo } from './repo';
import { decryptCredentials, isOwnerSideMailError, persistRefreshedToken } from './_shared';

/**
 * Les deux portes HTTP de Mail, sur la surface publique du SDK (capacité
 * `routes.public`, `exposure: 'app'` : l'origine de l'app seulement). Toutes
 * deux sont des GET nus, sans session : le navigateur télécharge nativement, la
 * fenêtre de consentement revient de chez Google ou Microsoft. La pièce jointe
 * est autorisée par un ticket de session signé par l'hôte
 * (`deps.secrecy.redeem`) : il lie l'appelant, son espace et ce module, et se
 * rend contre ses codecs, l'étage gardé compris tant que sa session est
 * déverrouillée. Le retour OAuth, lui, ne fait que rapporter le code et le
 * `state` à la session qui les termine (`mail.oauthFinish`).
 */

export type MailRouteDeps = Pick<
    FeatureServiceDeps<MailRepo>,
    'repo' | 'secrecy' | 'cipherFor' | 'origins' | 'logger' | 'audit' | 'quotaFor' | 'pauses'
>;

/** La couture de test des routes : le client IMAP, sans réseau. Le reste, tickets compris, tourne tel quel. */
export interface MailRouteSeam {
    client?: Pick<typeof mailClient, 'fetchMessageRaw'>;
}

/** La charge d'un ticket de pièce jointe, telle que `mail.attachmentDownload` la pose. */
export const attachmentTicketSchema = z.object({
    messageId: z.number().int().positive(),
    attachmentId: z.string()
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
    var relay = document.body.dataset;
    if (window.opener) {
        window.opener.postMessage(
            {
                source: 'deveye-mail-oauth',
                code: relay.code || null,
                state: relay.state || null,
                error: relay.error || null
            },
            window.location.origin
        );
    }
    window.close();
})();
`;

/** Ce que la fenêtre rapporte à l'app : le code à échanger, ou le refus du fournisseur. */
export type OAuthRelay = { code: string; state: string } | { error: string };

/**
 * The single OAuth redirect target for Gmail/Microsoft 365 mailboxes. Opened in
 * a popup by the client; it always answers with a small self-closing HTML page
 * rather than a redirect, `window.opener.postMessage` being how the popup
 * reports back. Elle ne finalise rien : elle rapporte le code et le `state` à
 * la page qui l'a ouverte, et c'est `mail.oauthFinish`, dans cette session, qui
 * crée ou renouvelle la boîte. Un lien de consentement ouvert ailleurs
 * n'aboutit donc nulle part.
 *
 * `error` is never trustworthy: it is `?error=` straight off the query string,
 * so this page is reachable with arbitrary content on DevEye's own origin. Il
 * n'y traverse qu'échappé, en texte et en attribut ; la page ne porte aucun
 * script où il pourrait se glisser.
 */
export function popupResponse(relay: OAuthRelay): string {
    const failed = 'error' in relay;
    const text = failed
        ? `Échec de la connexion : ${escapeHtml(relay.error)}`
        : 'Connexion en cours, vous pouvez fermer cette fenêtre.';
    const data = failed
        ? `data-error="${escapeHtml(relay.error)}"`
        : `data-code="${escapeHtml(relay.code)}" data-state="${escapeHtml(relay.state)}"`;
    return `<!doctype html><html><head><meta charset="utf-8"><title>DevEye Mail</title></head>
<body style="font-family:sans-serif;padding:2rem;color:#333" ${data}>
<p>${text}</p>
<script src="${POPUP_SCRIPT_PATH}"></script>
</body></html>`;
}

export function mailRoutes(app: SdkPublicApp, deps: MailRouteDeps, seam: MailRouteSeam = {}): void {
    const client = seam.client ?? mailClient;

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
        // Mis en pause par l'offre depuis la délivrance du ticket : rien ne part vers IMAP.
        if (deps.pauses.isPaused('accounts', String(account.id))) {
            return reply.code(403).send({ error: 'plan_paused' });
        }

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

            // Toujours un fichier à enregistrer, jamais le type que l'expéditeur
            // annonce : du HTML ou du SVG servis comme tels sur l'origine de
            // l'app y tourneraient avec ses droits.
            reply.header('Content-Type', 'application/octet-stream');
            reply.header('X-Content-Type-Options', 'nosniff');
            reply.header('Content-Length', String(attachment.content.length));
            reply.header('Content-Disposition', contentDisposition(attachment.filename));
            return reply.send(attachment.content);
        } catch (e) {
            logFailure(
                deps.logger,
                isOwnerSideMailError(e),
                { err: e instanceof Error ? e.message : String(e) },
                'Mail attachment download failed',
                'error'
            );
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
        const query = oauthQuerySchema.safeParse(req.query);
        const { code, state, error } = query.success ? query.data : {};
        if (error) return reply.send(popupResponse({ error }));
        if (!code || !state) return reply.send(popupResponse({ error: 'Réponse incomplète du fournisseur' }));
        return reply.send(popupResponse({ code, state }));
    });
}
