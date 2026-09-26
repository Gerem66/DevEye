import { financeConfig, financeInvoicingLink, financeStatusSet, financeSummary } from '../../contracts/commands';
import { defineSdkFeature, FeatureError } from '@deveye/types/sdk/server';

import {
    decryptAll,
    encryptJson,
    financeCipher,
    readConfig,
    startOfMonth,
    toCategory,
    today,
    WRITE,
    type Ctx,
    type StoredCategory
} from '../_shared';
import { catchUp } from '../sources';
import { computeStatus } from '../status';

/** Réglages de l'espace, arrivée des règlements de Facturation, et carte de l'accueil. */

/** Là où se rangent les règlements quand personne n'a choisi. */
const DEFAULT_INVOICING_CATEGORY = 'Prestations';

export const financeConfigFeature = defineSdkFeature({
    ...financeConfig,
    handler: async (ctx: Ctx) => ({ config: await readConfig(ctx) })
});

/**
 * Où arrivent les règlements de Facturation. Les copies déjà faites restent là
 * où elles sont : changer de compte vaut pour les règlements à venir, et la
 * recopie suivante compare tout (la version est oubliée).
 */
export const financeInvoicingLinkFeature = defineSdkFeature({
    ...financeInvoicingLink,
    mutates: true,
    access: WRITE,
    handler: async (ctx: Ctx, input) => {
        if (input.accountId === null) {
            await ctx.repo.setInvoicingLink(ctx.workspaceId, null, null);
        } else {
            const account = await ctx.repo.findAccountPlain(input.accountId, ctx.workspaceId);
            if (!account) throw new FeatureError('not_found', 'Compte introuvable');
            if (account.archived === 1) {
                throw new FeatureError('validation', 'Un compte archivé ne reçoit plus rien : désarchivez-le d’abord.');
            }
            const categoryId = input.categoryId ?? (await defaultIncomeCategory(ctx));
            const category = await ctx.repo.findCategory(categoryId, ctx.workspaceId);
            if (!category) throw new FeatureError('not_found', 'Catégorie introuvable');
            if (category.flow !== 'income') {
                throw new FeatureError('validation', 'Les règlements se rangent dans une catégorie de recettes.');
            }
            await ctx.repo.setInvoicingLink(ctx.workspaceId, input.accountId, categoryId);
        }
        ctx.audit({
            action: 'finance.invoicingLink',
            description:
                input.accountId === null
                    ? 'Les règlements de Facturation n’arrivent plus dans Finances'
                    : 'Les règlements de Facturation arrivent dans Finances',
            metadata: { accountId: input.accountId }
        });
        return { config: await readConfig(ctx) };
    }
});

/**
 * Le statut de l'activité. Une micro-entreprise dit son activité et sa cadence,
 * sans quoi rien ne se calcule ; ce qui ne la concerne pas est oublié plutôt
 * que gardé en réserve. Le jour de suivi part du mois en cours quand personne
 * ne l'a dit : ce qui précède a été réglé hors de DevEye.
 */
export const financeStatusSetFeature = defineSdkFeature({
    ...financeStatusSet,
    mutates: true,
    access: WRITE,
    handler: async (ctx: Ctx, input) => {
        const status = input.status;
        if (status.legalStatus === 'micro' && (status.microActivity === null || status.declarationPeriod === null)) {
            throw new FeatureError(
                'validation',
                'Une micro-entreprise dit son activité et la cadence de ses déclarations.'
            );
        }
        const micro = status.legalStatus === 'micro';
        await ctx.repo.setStatus(ctx.workspaceId, {
            legalStatus: status.legalStatus,
            microActivity: micro ? status.microActivity : null,
            provisionRateBp: status.legalStatus === null ? null : status.provisionRateBp,
            incomeTaxPrepaid: micro && status.incomeTaxPrepaid,
            declarationPeriod: micro ? status.declarationPeriod : null,
            trackingSince: status.legalStatus === null ? null : (status.trackingSince ?? startOfMonth(today()))
        });
        ctx.audit({
            action: 'finance.statusSet',
            description: 'Statut de l’activité modifié',
            metadata: { legalStatus: status.legalStatus, microActivity: micro ? status.microActivity : null }
        });
        return { config: await readConfig(ctx) };
    }
});

/** « Prestations » si l'espace l'a déjà, créée sinon. Les noms sont chiffrés : la recherche se fait ici. */
async function defaultIncomeCategory(ctx: Ctx): Promise<number> {
    const cipher = financeCipher(ctx);
    const rows = await ctx.repo.listCategories(ctx.workspaceId);
    const categories = await decryptAll(cipher, rows, toCategory);
    const found = categories.find(
        (category) =>
            category.flow === 'income' &&
            category.name.localeCompare(DEFAULT_INVOICING_CATEGORY, 'fr', { sensitivity: 'base' }) === 0
    );
    if (found) return found.id;
    const payload: StoredCategory = { name: DEFAULT_INVOICING_CATEGORY };
    return ctx.repo.createCategory(ctx.workspaceId, {
        flow: 'income',
        color: 'green',
        icon: 'server',
        role: null,
        content: await encryptJson(cipher, payload)
    });
}

/** La carte de l'accueil : le solde plutôt qu'un décompte de comptes. */
export const financeSummaryFeature = defineSdkFeature({
    ...financeSummary,
    handler: async (ctx: Ctx) => {
        await catchUp(ctx);
        const now = today();
        const config = await readConfig(ctx);
        const [balance, accounts, flow] = await Promise.all([
            ctx.repo.totalBalance(ctx.workspaceId, now),
            ctx.repo.listAccounts(ctx.workspaceId, false, now),
            ctx.repo.sumTransactions(ctx.workspaceId, { from: startOfMonth(now), to: now })
        ]);
        const status = await computeStatus(ctx, config.status, config.vatEnabled, now, balance, null);
        return {
            summary: {
                currency: config.currency,
                balance,
                income: flow.income,
                expense: flow.expense,
                accountCount: accounts.length,
                setAside: status?.setAside.total ?? null
            }
        };
    }
});
