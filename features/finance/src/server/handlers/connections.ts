import {
    financeAccountBankLink,
    financeBankFinish,
    financeBankList,
    financeConnectionAddQonto,
    financeConnectionList,
    financeConnectionRemove,
    financeConnectionStart,
    financeConnectionSync,
    financeConnectionUpdate
} from '../../contracts/commands';
import { defineSdkFeature, FeatureError } from '@deveye/types/sdk/server';

import {
    BANK_CALLBACK_PATH,
    isQontoSecret,
    readConnection,
    sealConnection,
    syncConnection,
    toConnection,
    toLink,
    type StoredConnection
} from '../banking';
import { closeSession, enableBankingApp, listBanks, openSession, startAuthorization } from '../banks/enableBanking';
import { qontoConnector } from '../banks/qonto';
import { BankError } from '../banks/types';
import { bankPsuTypeSchema, type FinanceConnectionRow } from '../../contracts/banking';
import { addDays, isDuplicate, WRITE, type Ctx } from '../_shared';
import { z } from 'zod';

/**
 * Les connexions bancaires de l'espace, gérées dans Réglages, Sources : le seul
 * endroit où elles se créent, se corrigent et se retirent. Un compte du livre
 * ne fait qu'en choisir une. Chacune pèse sur l'offre du propriétaire de
 * l'espace (`bankConnections`) : elle interroge la banque toutes les six heures.
 */

const QUOTA = 'bankConnections';

/** La plus longue durée de consentement demandée, quand la banque en accepte davantage. */
const CONSENT_MAX_SECONDS = 180 * 86_400;

/** La charge du `state`, telle que `finance.connectionStart` la pose et `finance.bankFinish` la relit. */
const bankStateSchema = z.object({
    connectionId: z.number().int().positive().nullable(),
    label: z.string(),
    bank: z.string(),
    country: z.string().length(2),
    psuType: bankPsuTypeSchema
});

const paused = (ctx: Ctx, id: number) => ctx.quota.isPaused(QUOTA, String(id));

async function load(ctx: Ctx, id: number): Promise<FinanceConnectionRow> {
    const row = await ctx.repo.findConnection(id, ctx.workspaceId);
    if (!row) throw new FeatureError('not_found', 'Connexion introuvable');
    return row;
}

async function present(ctx: Ctx, id: number) {
    const row = await load(ctx, id);
    return toConnection(row, await readConnection(ctx, row), paused(ctx, row.id));
}

/** Un refus de la banque dit en clair ; celui qui vise le serveur reste une panne, à signaler. */
function refused(error: unknown): never {
    if (error instanceof BankError) {
        throw new FeatureError(error.kind === 'instance' ? 'internal' : 'validation', error.message);
    }
    throw error;
}

function requireEnableBanking() {
    const app = enableBankingApp();
    if (app === null) {
        throw new FeatureError(
            'validation',
            'Ce serveur ne relie pas d’autres banques que Qonto : l’import de relevé reste possible.'
        );
    }
    return app;
}

export const financeConnectionListFeature = defineSdkFeature({
    ...financeConnectionList,
    handler: async (ctx: Ctx) => {
        const [rows, links, quota] = await Promise.all([
            ctx.repo.listConnections(ctx.workspaceId),
            ctx.repo.listBankLinks(ctx.workspaceId),
            ctx.quota.usage(QUOTA)
        ]);
        return {
            connections: await Promise.all(
                rows.map(async (row) => toConnection(row, await readConnection(ctx, row), paused(ctx, row.id)))
            ),
            links: links.map(toLink),
            enableBanking: enableBankingApp() !== null,
            quota
        };
    }
});

export const financeConnectionAddQontoFeature = defineSdkFeature({
    ...financeConnectionAddQonto,
    mutates: true,
    access: WRITE,
    handler: async (ctx: Ctx, input) => {
        await ctx.quota.assert(QUOTA, async (owned) => (await ctx.repo.countConnectionsInWorkspaces(owned)) + 1);
        const secret = { login: input.login, secretKey: input.secretKey };
        const accounts = await qontoConnector(secret).accounts().catch(refused);
        const stored: StoredConnection = { label: input.label, bankName: 'Qonto', secret, accounts };
        const id = await ctx.repo.createConnection(ctx.workspaceId, {
            provider: 'qonto',
            validUntil: null,
            content: await sealConnection(ctx, stored)
        });
        ctx.audit({
            action: 'finance.connectionAdd',
            description: 'Connexion bancaire ajoutée (Qonto)',
            metadata: { connectionId: id, provider: 'qonto' }
        });
        return { connection: await present(ctx, id) };
    }
});

export const financeConnectionUpdateFeature = defineSdkFeature({
    ...financeConnectionUpdate,
    mutates: true,
    access: WRITE,
    handler: async (ctx: Ctx, input) => {
        const row = await load(ctx, input.connectionId);
        const stored = await readConnection(ctx, row);
        const renewing = input.login !== null || input.secretKey !== null;
        if (stored === null && !(row.provider === 'qonto' && input.login !== null && input.secretKey !== null)) {
            throw new FeatureError(
                'validation',
                'Les accès de cette connexion ne se lisent plus : saisissez-les à nouveau.'
            );
        }
        if (renewing && row.provider !== 'qonto') {
            throw new FeatureError(
                'validation',
                'Une banque reliée par Enable Banking se reconnecte, sans clé à saisir.'
            );
        }
        if (!renewing && stored !== null) {
            await ctx.repo.setConnectionContent(
                row.id,
                ctx.workspaceId,
                await sealConnection(ctx, { ...stored, label: input.label })
            );
            return { connection: await present(ctx, row.id) };
        }
        const previous = stored !== null && isQontoSecret(stored.secret) ? stored.secret : null;
        const secret = {
            login: input.login ?? previous?.login ?? '',
            secretKey: input.secretKey ?? previous?.secretKey ?? ''
        };
        const accounts = await qontoConnector(secret).accounts().catch(refused);
        await ctx.repo.replaceConnection(row.id, ctx.workspaceId, {
            validUntil: null,
            content: await sealConnection(ctx, { label: input.label, bankName: 'Qonto', secret, accounts })
        });
        ctx.audit({
            action: 'finance.connectionUpdate',
            description: 'Accès d’une connexion bancaire remplacés',
            metadata: { connectionId: row.id }
        });
        return { connection: await present(ctx, row.id) };
    }
});

export const financeConnectionRemoveFeature = defineSdkFeature({
    ...financeConnectionRemove,
    mutates: true,
    access: WRITE,
    handler: async (ctx: Ctx, input) => {
        const row = await load(ctx, input.connectionId);
        const stored = await readConnection(ctx, row);
        const app = enableBankingApp();
        // Le consentement se rend aussi chez l'agrégateur : une connexion retirée ici ne doit plus rien pouvoir lire.
        if (stored !== null && !isQontoSecret(stored.secret) && app !== null) {
            await closeSession(app, stored.secret.sessionId);
        }
        await ctx.repo.deleteConnection(row.id, ctx.workspaceId);
        ctx.audit({
            action: 'finance.connectionRemove',
            level: 'warning',
            description: 'Connexion bancaire retirée',
            metadata: { connectionId: row.id, provider: row.provider }
        });
        return { connectionId: row.id };
    }
});

export const financeConnectionSyncFeature = defineSdkFeature({
    ...financeConnectionSync,
    mutates: true,
    access: WRITE,
    handler: async (ctx: Ctx, input) => {
        const row = await load(ctx, input.connectionId);
        await ctx.quota.assertActive(QUOTA, String(row.id));
        if (row.status === 'expired') {
            throw new FeatureError('conflict', 'Le consentement donné à la banque a pris fin : reconnectez-la.');
        }
        const outcome = await syncConnection(ctx, row);
        return { connection: await present(ctx, row.id), added: outcome.added };
    }
});

export const financeBankListFeature = defineSdkFeature({
    ...financeBankList,
    access: WRITE,
    handler: async (_ctx: Ctx, input) => {
        const app = requireEnableBanking();
        const banks = await listBanks(app, input.country.toUpperCase()).catch(refused);
        return {
            banks: banks
                .map(({ name, country, psuTypes }) => ({ name, country, psuTypes }))
                .sort((a, b) => a.name.localeCompare(b.name, 'fr'))
        };
    }
});

export const financeConnectionStartFeature = defineSdkFeature({
    ...financeConnectionStart,
    access: WRITE,
    handler: async (ctx: Ctx, input) => {
        const app = requireEnableBanking();
        if (input.connectionId === null) {
            // Refusé avant d'envoyer la personne chez sa banque, plutôt qu'au retour.
            await ctx.quota.assert(QUOTA, async (owned) => (await ctx.repo.countConnectionsInWorkspaces(owned)) + 1);
        } else {
            const row = await load(ctx, input.connectionId);
            if (row.provider !== 'enablebanking') {
                throw new FeatureError('validation', 'Une connexion Qonto se corrige par sa clé, sans consentement.');
            }
        }
        const country = input.bank.country.toUpperCase();
        const bank = (await listBanks(app, country).catch(refused)).find((entry) => entry.name === input.bank.name);
        if (!bank) throw new FeatureError('not_found', 'Banque introuvable');
        const consent = Math.min(bank.maxConsentSeconds ?? 90 * 86_400, CONSENT_MAX_SECONDS);
        // Scellé par l'hôte : la route de retour n'a plus de session, elle ne fera que reprendre ce ticket.
        const state = await ctx.secrecy.ticket(
            {
                connectionId: input.connectionId,
                label: input.label,
                bank: bank.name,
                country,
                psuType: input.psuType
            },
            { ttlSeconds: 1800 }
        );
        const authUrl = await startAuthorization(app, {
            bank: bank.name,
            country,
            psuType: input.psuType,
            state,
            redirectUrl: `${ctx.origins.app}${BANK_CALLBACK_PATH}`,
            validUntil: Math.floor(Date.now() / 1000) + consent
        }).catch(refused);
        return { authUrl };
    }
});

/**
 * La fin du consentement, dans la session qui l'a lancé : la fenêtre de la
 * banque n'a fait que rapporter le code et le `state`, et le `state` ne se rend
 * qu'à la session qui l'a émis. Un lien de consentement envoyé à un tiers
 * n'aboutit donc nulle part. `exchange` s'injecte pour les tests.
 */
export function financeBankFinishFeature(exchange: typeof openSession = openSession) {
    return defineSdkFeature({
        ...financeBankFinish,
        mutates: true,
        access: WRITE,
        handler: async (ctx: Ctx, input) => {
            const ticket = await ctx.secrecy.redeem(input.state);
            const claims = ticket ? bankStateSchema.safeParse(ticket.payload) : null;
            if (!claims?.success) {
                throw new FeatureError('validation', 'Lien de connexion expiré : recommencez depuis DevEye.');
            }
            const { connectionId, label, bank, country, psuType } = claims.data;
            const app = requireEnableBanking();
            const session = await exchange(app, input.code).catch(refused);
            const stored: StoredConnection = {
                label,
                bankName: bank,
                country,
                psuType,
                secret: { sessionId: session.sessionId },
                accounts: session.accounts
            };

            if (connectionId !== null) {
                const row = await load(ctx, connectionId);
                const previous = await readConnection(ctx, row);
                if (previous !== null && 'sessionId' in previous.secret) {
                    await closeSession(app, previous.secret.sessionId);
                }
                // Une session neuve renomme les comptes : chaque compte du livre
                // retrouve le sien par ce que la banque garde d'une fois à l'autre.
                for (const link of await ctx.repo.listConnectionLinks(row.id, ctx.workspaceId)) {
                    const before = previous?.accounts.find((account) => account.id === link.external_account_id);
                    const after = session.accounts.find(
                        (account) => before?.key !== undefined && account.key === before.key
                    );
                    await ctx.repo.setBankLink(
                        link.account_id,
                        ctx.workspaceId,
                        after ? { connectionId: row.id, externalAccountId: after.id, since: link.since } : null
                    );
                }
                await ctx.repo.replaceConnection(row.id, ctx.workspaceId, {
                    validUntil: session.validUntil,
                    content: await sealConnection(ctx, stored)
                });
                ctx.audit({
                    action: 'finance.connectionRenew',
                    description: `Banque reconnectée (${bank})`,
                    metadata: { connectionId: row.id }
                });
                return { connectionId: row.id };
            }

            // Même barrage qu'au départ : entre-temps, une autre connexion a pu prendre la place.
            await ctx.quota.assert(QUOTA, async (owned) => (await ctx.repo.countConnectionsInWorkspaces(owned)) + 1);
            const id = await ctx.repo.createConnection(ctx.workspaceId, {
                provider: 'enablebanking',
                validUntil: session.validUntil,
                content: await sealConnection(ctx, stored)
            });
            ctx.audit({
                action: 'finance.connectionAdd',
                description: `Connexion bancaire ajoutée (${bank})`,
                metadata: { connectionId: id, provider: 'enablebanking' }
            });
            return { connectionId: id };
        }
    });
}

export const financeAccountBankLinkFeature = defineSdkFeature({
    ...financeAccountBankLink,
    mutates: true,
    access: WRITE,
    handler: async (ctx: Ctx, input) => {
        const account = await ctx.repo.findAccountPlain(input.accountId, ctx.workspaceId);
        if (!account) throw new FeatureError('not_found', 'Compte introuvable');
        const done = async (added: number) => ({
            links: (await ctx.repo.listBankLinks(ctx.workspaceId)).map(toLink),
            added
        });

        if (input.connectionId === null || input.externalAccountId === null) {
            await ctx.repo.setBankLink(account.id, ctx.workspaceId, null);
            return done(0);
        }
        const row = await load(ctx, input.connectionId);
        const stored = await readConnection(ctx, row);
        if (!stored?.accounts.some((remote) => remote.id === input.externalAccountId)) {
            throw new FeatureError('validation', 'Ce compte n’existe pas chez cette banque.');
        }

        const links = await ctx.repo.listBankLinks(ctx.workspaceId);
        const current = links.find((link) => link.account_id === account.id);
        const taken = links.find(
            (link) =>
                link.connection_id === row.id &&
                link.external_account_id === input.externalAccountId &&
                link.account_id !== account.id
        );
        if (taken) throw new FeatureError('conflict', 'Ce compte de la banque alimente déjà un autre compte du livre.');

        // Le même compte distant garde son point de départ ; un nouveau part du
        // lendemain de la dernière ligne déjà là, pour ne rien compter deux fois.
        let since = account.opened_on;
        if (current && current.connection_id === row.id && current.external_account_id === input.externalAccountId) {
            since = current.since;
        } else {
            const latest = await ctx.repo.latestLineDate(account.id, ctx.workspaceId);
            if (latest !== null && addDays(latest, 1) > since) since = addDays(latest, 1);
        }
        try {
            await ctx.repo.setBankLink(account.id, ctx.workspaceId, {
                connectionId: row.id,
                externalAccountId: input.externalAccountId,
                since
            });
        } catch (error) {
            if (isDuplicate(error)) {
                throw new FeatureError('conflict', 'Ce compte de la banque alimente déjà un autre compte du livre.');
            }
            throw error;
        }
        if (row.status === 'expired' || paused(ctx, row.id)) return done(0);
        const outcome = await syncConnection(ctx, row);
        return done(outcome.added);
    }
});
