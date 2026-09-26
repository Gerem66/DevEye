import { z } from 'zod';

import { bankPsuTypeSchema } from '../contracts/banking';
import type { FeatureServiceDeps, SdkPublicApp } from '@deveye/types/sdk/server';

import { BANK_CALLBACK_PATH, readConnection, sealConnection, type StoredConnection } from './banking';
import { closeSession, enableBankingApp, openSession } from './banks/enableBanking';
import { BankError } from './banks/types';
import type { FinanceRepo } from './repo';

/**
 * Le retour de la banque après le consentement, sur la surface publique du SDK
 * (capacité `routes.public`, origine de l'app seulement). Sans session : ce qui
 * l'autorise est le ticket que `finance.connectionStart` a scellé dans `state`,
 * qui lie la personne, son espace et ce module.
 */

export type FinanceRouteDeps = Pick<
    FeatureServiceDeps<FinanceRepo>,
    'repo' | 'secrecy' | 'logger' | 'audit' | 'quotaFor' | 'live'
>;

/** La charge du `state`, telle que `finance.connectionStart` la pose. */
export const bankStateSchema = z.object({
    connectionId: z.number().int().positive().nullable(),
    label: z.string(),
    bank: z.string(),
    country: z.string().length(2),
    psuType: bankPsuTypeSchema
});

const callbackQuerySchema = z.object({
    code: z.string().optional(),
    state: z.string().optional(),
    error: z.string().optional()
});

const POPUP_SCRIPT_PATH = '/api/finance/bank/close.js';

/**
 * Ce que la fenêtre exécute : poster son verdict à l'app qui l'a ouverte, puis
 * se fermer. Servi comme fichier, que la politique `script-src 'self'` couvre
 * sans rien lui ajouter.
 */
const POPUP_SCRIPT = `(function () {
    var verdict = document.body.dataset;
    if (window.opener) {
        window.opener.postMessage(
            { source: 'deveye-finance-bank', ok: verdict.ok === 'true', error: verdict.error || null },
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

/** Toujours une page qui se ferme seule, jamais une redirection. Le message n'y passe qu'échappé. */
export function popupPage(ok: boolean, message?: string): string {
    const text = ok
        ? 'Banque reliée, vous pouvez fermer cette fenêtre.'
        : `Échec : ${escapeHtml(message ?? 'inconnu')}`;
    return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>DevEye Finances</title></head>
<body style="font-family:sans-serif;padding:2rem" data-ok="${ok}" data-error="${escapeHtml(message ?? '')}">
<p>${text}</p>
<script src="${POPUP_SCRIPT_PATH}"></script>
</body></html>`;
}

/** La couture des tests : l'échange du code, sans réseau. */
export interface FinanceRouteSeam {
    openSession?: typeof openSession;
}

export function financeRoutes(app: SdkPublicApp, deps: FinanceRouteDeps, seam: FinanceRouteSeam = {}): void {
    const exchange = seam.openSession ?? openSession;

    app.get(POPUP_SCRIPT_PATH, { exposure: 'app' }, async (_req, reply) => {
        reply.header('Content-Type', 'application/javascript; charset=utf-8');
        return reply.send(POPUP_SCRIPT);
    });

    app.get(BANK_CALLBACK_PATH, { exposure: 'app' }, async (req, reply) => {
        reply.header('Content-Type', 'text/html; charset=utf-8');
        const page = (ok: boolean, message?: string) => reply.send(popupPage(ok, message));
        const query = callbackQuerySchema.safeParse(req.query);
        const { code, state, error } = query.success ? query.data : {};

        if (error) return page(false, 'la banque n’a pas donné son accord.');
        if (!code || !state) return page(false, 'réponse incomplète de la banque.');
        const ticket = await deps.secrecy.redeem(state);
        const claims = ticket ? bankStateSchema.safeParse(ticket.payload) : null;
        if (!ticket || !claims?.success) return page(false, 'lien de connexion expiré, recommencez depuis DevEye.');
        const enableBanking = enableBankingApp();
        if (enableBanking === null) return page(false, 'ce serveur ne relie plus d’autres banques que Qonto.');

        const { workspaceId, userId } = ticket;
        const io = { cipher: () => ticket.cipher.server };
        try {
            const session = await exchange(enableBanking, code);
            const stored: StoredConnection = {
                label: claims.data.label,
                bankName: claims.data.bank,
                country: claims.data.country,
                psuType: claims.data.psuType,
                secret: { sessionId: session.sessionId },
                accounts: session.accounts
            };

            if (claims.data.connectionId !== null) {
                const row = await deps.repo.findConnection(claims.data.connectionId, workspaceId);
                if (!row) return page(false, 'connexion introuvable, elle a pu être retirée entre-temps.');
                const previous = await readConnection(io, row);
                if (previous !== null && 'sessionId' in previous.secret) {
                    await closeSession(enableBanking, previous.secret.sessionId);
                }
                // Une session neuve renomme les comptes : chaque compte du livre
                // retrouve le sien par ce que la banque garde d'une fois à l'autre.
                for (const link of await deps.repo.listConnectionLinks(row.id, workspaceId)) {
                    const before = previous?.accounts.find((account) => account.id === link.external_account_id);
                    const after = session.accounts.find(
                        (account) => before?.key !== undefined && account.key === before.key
                    );
                    await deps.repo.setBankLink(
                        link.account_id,
                        workspaceId,
                        after ? { connectionId: row.id, externalAccountId: after.id, since: link.since } : null
                    );
                }
                await deps.repo.replaceConnection(row.id, workspaceId, {
                    validUntil: session.validUntil,
                    content: await sealConnection(io, stored)
                });
                deps.audit({
                    action: 'finance.connectionRenew',
                    userId,
                    description: `Banque reconnectée (${claims.data.bank})`,
                    metadata: { connectionId: row.id, workspaceId }
                });
            } else {
                // Même barrage qu'au départ : entre-temps, une autre connexion a pu prendre la place.
                await deps
                    .quotaFor(workspaceId)
                    .assert(
                        'bankConnections',
                        async (owned) => (await deps.repo.countConnectionsInWorkspaces(owned)) + 1
                    );
                const id = await deps.repo.createConnection(workspaceId, {
                    provider: 'enablebanking',
                    validUntil: session.validUntil,
                    content: await sealConnection(io, stored)
                });
                deps.audit({
                    action: 'finance.connectionAdd',
                    userId,
                    description: `Connexion bancaire ajoutée (${claims.data.bank})`,
                    metadata: { connectionId: id, provider: 'enablebanking', workspaceId }
                });
            }
            deps.live.changed(workspaceId);
            return page(true);
        } catch (e) {
            if (e instanceof BankError) return page(false, e.message);
            const quota = (e as { code?: string } | null)?.code === 'quota_exceeded';
            if (!quota)
                deps.logger.error(
                    { err: e instanceof Error ? e.message : String(e) },
                    'finance: retour de la banque en échec'
                );
            return page(
                false,
                quota
                    ? 'votre offre ne permet pas une connexion bancaire de plus.'
                    : 'la connexion n’a pas pu être enregistrée.'
            );
        }
    });
}
