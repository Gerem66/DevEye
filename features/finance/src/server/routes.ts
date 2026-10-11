import { z } from 'zod';

import type { SdkPublicApp } from '@deveye/types/sdk/server';

import { BANK_CALLBACK_PATH } from './banking';

/**
 * Le retour de la banque après le consentement, sur la surface publique du SDK
 * (capacité `routes.public`, origine de l'app seulement). Sans session, il ne
 * finalise rien : il rapporte le code et le `state` à la page qui a ouvert la
 * fenêtre, et c'est `finance.bankFinish`, dans cette session, qui relie la
 * banque. Un lien de consentement ouvert ailleurs n'aboutit donc nulle part.
 */

const callbackQuerySchema = z.object({
    code: z.string().optional(),
    state: z.string().optional(),
    error: z.string().optional()
});

const POPUP_SCRIPT_PATH = '/api/finance/bank/close.js';

/**
 * Ce que la fenêtre exécute : rapporter à l'app qui l'a ouverte ce que la
 * banque a rendu, puis se fermer. Servi comme fichier, que la politique
 * `script-src 'self'` couvre sans rien lui ajouter.
 */
const POPUP_SCRIPT = `(function () {
    var relay = document.body.dataset;
    if (window.opener) {
        window.opener.postMessage(
            {
                source: 'deveye-finance-bank',
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

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/** Ce que la fenêtre rapporte à l'app : le code à échanger, ou le refus de la banque. */
export type BankRelay = { code: string; state: string } | { error: string };

/** Toujours une page qui se ferme seule, jamais une redirection. Rien n'y passe qu'échappé. */
export function popupPage(relay: BankRelay): string {
    const failed = 'error' in relay;
    const text = failed ? `Échec : ${escapeHtml(relay.error)}` : 'Banque consultée, vous pouvez fermer cette fenêtre.';
    const data = failed
        ? `data-error="${escapeHtml(relay.error)}"`
        : `data-code="${escapeHtml(relay.code)}" data-state="${escapeHtml(relay.state)}"`;
    return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>DevEye Finances</title></head>
<body style="font-family:sans-serif;padding:2rem" ${data}>
<p>${text}</p>
<script src="${POPUP_SCRIPT_PATH}"></script>
</body></html>`;
}

export function financeRoutes(app: SdkPublicApp): void {
    app.get(POPUP_SCRIPT_PATH, { exposure: 'app' }, async (_req, reply) => {
        reply.header('Content-Type', 'application/javascript; charset=utf-8');
        return reply.send(POPUP_SCRIPT);
    });

    app.get(BANK_CALLBACK_PATH, { exposure: 'app' }, async (req, reply) => {
        reply.header('Content-Type', 'text/html; charset=utf-8');
        const query = callbackQuerySchema.safeParse(req.query);
        const { code, state, error } = query.success ? query.data : {};
        if (error) return reply.send(popupPage({ error: 'la banque n’a pas donné son accord.' }));
        if (!code || !state) return reply.send(popupPage({ error: 'réponse incomplète de la banque.' }));
        return reply.send(popupPage({ code, state }));
    });
}
