import { financeBudgetList, financeBudgetRemove, financeBudgetSet } from '../../contracts/commands';
import type { FinanceBudget, FinanceBudgetRow } from '../../contracts/domain';
import { defineSdkFeature, FeatureError } from '@deveye/types/sdk/server';

import { periodBounds, postDueRecurring, today, WRITE, type Ctx } from '../_shared';

/** `spent` et `remaining` ne sont jamais stockés : un budget est une règle, pas un compteur. */

/** Habille une ligne de budget de ce que la période en cours en a consommé. */
async function withConsumption(ctx: Ctx, row: FinanceBudgetRow): Promise<FinanceBudget> {
    const { start, end } = periodBounds(row.period, today());
    const spent = await ctx.repo.spentByCategory(ctx.workspaceId, row.category_id, start, end);
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

export const financeBudgetListFeature = defineSdkFeature({
    ...financeBudgetList,
    handler: async (ctx: Ctx) => {
        await postDueRecurring(ctx);
        const rows = await ctx.repo.listBudgets(ctx.workspaceId);
        return { budgets: await Promise.all(rows.map((row) => withConsumption(ctx, row))) };
    }
});

export const financeBudgetSetFeature = defineSdkFeature({
    ...financeBudgetSet,
    mutates: true,
    access: WRITE,
    handler: async (ctx: Ctx, input) => {
        const category = await ctx.repo.findCategory(input.categoryId, ctx.workspaceId);
        if (!category) throw new FeatureError('not_found', 'Catégorie introuvable');
        // Une enveloppe sur une catégorie de recettes serait un plafond de revenus : un contresens.
        if (category.flow !== 'expense') {
            throw new FeatureError('validation', 'Un budget se pose sur une catégorie de dépenses.');
        }
        const row = await ctx.repo.upsertBudget(ctx.workspaceId, input.categoryId, input.amount, input.period);
        return { budget: await withConsumption(ctx, row) };
    }
});

export const financeBudgetRemoveFeature = defineSdkFeature({
    ...financeBudgetRemove,
    mutates: true,
    access: WRITE,
    handler: async (ctx: Ctx, input) => {
        const existing = await ctx.repo.findBudget(input.budgetId, ctx.workspaceId);
        if (!existing) throw new FeatureError('not_found', 'Budget introuvable');
        await ctx.repo.deleteBudget(input.budgetId, ctx.workspaceId);
        return { budgetId: input.budgetId };
    }
});

export { withConsumption };
