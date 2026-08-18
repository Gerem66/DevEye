import { financeBudgetList, financeBudgetRemove, financeBudgetSet } from 'deveye-types';
import type { FinanceBudget, FinanceBudgetRow } from 'deveye-types';

import { defineFeature, FeatureError, type FeatureContext, type FeatureDefinition } from '../_define';
import { periodBounds, postDueRecurring, READ, today, WRITE } from './_shared';

/**
 * Les budgets: une enveloppe posée sur une catégorie de dépenses.
 *
 * `spent` et `remaining` ne sont **jamais stockés**. Un budget est une règle,
 * pas un compteur: mémoriser le compteur le ferait diverger dès qu'une opération
 * passée est corrigée ou supprimée, et plus rien ne dirait laquelle des deux
 * valeurs est la vraie. On recalcule à la lecture, sur la période en cours.
 */

/** Habille une ligne de budget de ce que la période en cours en a consommé. */
async function withConsumption(ctx: FeatureContext, row: FinanceBudgetRow): Promise<FinanceBudget> {
    const { start, end } = periodBounds(row.period, today());
    const spent = await ctx.db.finance.spentByCategory(ctx.workspaceId, row.category_id, start, end);
    return {
        id: row.id,
        categoryId: row.category_id,
        amount: Number(row.amount),
        period: row.period,
        spent,
        remaining: Number(row.amount) - spent,
        periodStart: start,
        periodEnd: end
    };
}

export const financeBudgetListFeature: FeatureDefinition<
    typeof financeBudgetList.command,
    typeof financeBudgetList.input,
    typeof financeBudgetList.output
> = defineFeature({
    ...financeBudgetList,
    access: READ,
    handler: async (ctx) => {
        await postDueRecurring(ctx);
        const rows = await ctx.db.finance.listBudgets(ctx.workspaceId);
        return { budgets: await Promise.all(rows.map((row) => withConsumption(ctx, row))) };
    }
});

export const financeBudgetSetFeature: FeatureDefinition<
    typeof financeBudgetSet.command,
    typeof financeBudgetSet.input,
    typeof financeBudgetSet.output
> = defineFeature({
    ...financeBudgetSet,
    mutates: true,
    access: WRITE,
    handler: async (ctx, input) => {
        const category = await ctx.db.finance.findCategory(input.categoryId, ctx.workspaceId);
        if (!category) throw new FeatureError('not_found', 'Catégorie introuvable');
        // Une enveloppe borne une dépense. En poser une sur une catégorie de
        // recettes reviendrait à se fixer un plafond de revenus, ce qui n'est
        // pas une notion de gestion mais un contresens.
        if (category.flow !== 'expense') {
            throw new FeatureError('validation', 'Un budget se pose sur une catégorie de dépenses.');
        }
        const row = await ctx.db.finance.upsertBudget(ctx.workspaceId, input.categoryId, input.amount, input.period);
        return { budget: await withConsumption(ctx, row) };
    }
});

export const financeBudgetRemoveFeature: FeatureDefinition<
    typeof financeBudgetRemove.command,
    typeof financeBudgetRemove.input,
    typeof financeBudgetRemove.output
> = defineFeature({
    ...financeBudgetRemove,
    mutates: true,
    access: WRITE,
    handler: async (ctx, input) => {
        const existing = await ctx.db.finance.findBudget(input.budgetId, ctx.workspaceId);
        if (!existing) throw new FeatureError('not_found', 'Budget introuvable');
        await ctx.db.finance.deleteBudget(input.budgetId, ctx.workspaceId);
        return { budgetId: input.budgetId };
    }
});

export { withConsumption };
