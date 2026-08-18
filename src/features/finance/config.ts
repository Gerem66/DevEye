import { financeConfig, financeConfigUpdate, financeSummary } from 'deveye-types';

import { defineFeature, type FeatureDefinition } from '../_define';
import { postDueRecurring, readConfig, startOfMonth, today, READ, WRITE } from './_shared';

/**
 * Réglages de l'espace et carte de l'accueil.
 *
 * Deux commandes de lecture minuscules et une écriture, réunies parce qu'elles
 * répondent à la même question: « dans quel cadre lit-on ce livre, et où en
 * est-il ». Tout le reste de la feature suppose ces réponses connues.
 */

export const financeConfigFeature: FeatureDefinition<
    typeof financeConfig.command,
    typeof financeConfig.input,
    typeof financeConfig.output
> = defineFeature({
    ...financeConfig,
    access: READ,
    handler: async (ctx) => ({ config: await readConfig(ctx) })
});

export const financeConfigUpdateFeature: FeatureDefinition<
    typeof financeConfigUpdate.command,
    typeof financeConfigUpdate.input,
    typeof financeConfigUpdate.output
> = defineFeature({
    ...financeConfigUpdate,
    mutates: true,
    access: WRITE,
    handler: async (ctx, input) => {
        const row = await ctx.db.finance.upsertConfig(ctx.workspaceId, input.config.currency, input.config.vatEnabled);
        ctx.audit({
            action: 'finance.configUpdate',
            description: 'Réglages des finances modifiés',
            metadata: { currency: row.currency, vatEnabled: row.vat_enabled === 1 }
        });
        return { config: { currency: row.currency, vatEnabled: row.vat_enabled === 1 } };
    }
});

/**
 * Ce que lit la carte de l'accueil: le solde, et le mois en cours.
 *
 * Le solde plutôt qu'un décompte de comptes, parce que « 3 comptes » ne dit rien
 * qu'on veuille savoir d'un coup d'œil depuis l'accueil, là où « 4 210 € » dit
 * exactement ce pour quoi on ouvre la feature.
 */
export const financeSummaryFeature: FeatureDefinition<
    typeof financeSummary.command,
    typeof financeSummary.input,
    typeof financeSummary.output
> = defineFeature({
    ...financeSummary,
    access: READ,
    handler: async (ctx) => {
        await postDueRecurring(ctx);
        const now = today();
        const config = await readConfig(ctx);
        const [balance, accounts, flow] = await Promise.all([
            ctx.db.finance.totalBalance(ctx.workspaceId, now),
            ctx.db.finance.listAccounts(ctx.workspaceId, false, now),
            ctx.db.finance.sumTransactions(ctx.workspaceId, { from: startOfMonth(now), to: now })
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
