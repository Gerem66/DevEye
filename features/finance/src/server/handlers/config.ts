import { financeConfig, financeConfigUpdate, financeSummary } from '../../contracts/commands';
import { defineSdkFeature } from '@deveye/types/sdk/server';

import { postDueRecurring, readConfig, startOfMonth, today, WRITE, type Ctx } from '../_shared';

/** Réglages de l'espace et carte de l'accueil. */

export const financeConfigFeature = defineSdkFeature({
    ...financeConfig,
    handler: async (ctx: Ctx) => ({ config: await readConfig(ctx) })
});

export const financeConfigUpdateFeature = defineSdkFeature({
    ...financeConfigUpdate,
    mutates: true,
    access: WRITE,
    handler: async (ctx: Ctx, input) => {
        const row = await ctx.repo.upsertConfig(ctx.workspaceId, input.config.currency, input.config.vatEnabled);
        ctx.audit({
            action: 'finance.configUpdate',
            description: 'Réglages des finances modifiés',
            metadata: { currency: row.currency, vatEnabled: row.vat_enabled === 1 }
        });
        return { config: { currency: row.currency, vatEnabled: row.vat_enabled === 1 } };
    }
});

/** La carte de l'accueil : le solde plutôt qu'un décompte de comptes. */
export const financeSummaryFeature = defineSdkFeature({
    ...financeSummary,
    handler: async (ctx: Ctx) => {
        await postDueRecurring(ctx);
        const now = today();
        const config = await readConfig(ctx);
        const [balance, accounts, flow] = await Promise.all([
            ctx.repo.totalBalance(ctx.workspaceId, now),
            ctx.repo.listAccounts(ctx.workspaceId, false, now),
            ctx.repo.sumTransactions(ctx.workspaceId, { from: startOfMonth(now), to: now })
        ]);
        return {
            summary: {
                currency: config.currency,
                balance,
                income: flow.income,
                expense: flow.expense,
                accountCount: accounts.length
            }
        };
    }
});
