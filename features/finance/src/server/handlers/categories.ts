import {
    financeCategoryAdd,
    financeCategoryList,
    financeCategoryRemove,
    financeCategoryReorder,
    financeCategoryUpdate
} from '../../contracts/commands';
import { defineSdkFeature, FeatureError } from '@deveye/types/sdk/server';

import { decryptAll, encryptJson, financeCipher, toCategory, WRITE, type Ctx, type StoredCategory } from '../_shared';

/**
 * Les catégories. Une catégorie ne sert qu'un sens : additionner entrées et
 * sorties sous un même intitulé ne veut rien dire.
 */

export const financeCategoryListFeature = defineSdkFeature({
    ...financeCategoryList,
    handler: async (ctx: Ctx) => {
        const rows = await ctx.repo.listCategories(ctx.workspaceId);
        return { categories: await decryptAll(financeCipher(ctx), rows, toCategory) };
    }
});

export const financeCategoryAddFeature = defineSdkFeature({
    ...financeCategoryAdd,
    mutates: true,
    access: WRITE,
    handler: async (ctx: Ctx, input) => {
        const payload: StoredCategory = { name: input.category.name.trim() };
        const id = await ctx.repo.createCategory(ctx.workspaceId, {
            flow: input.category.flow,
            color: input.category.color,
            icon: input.category.icon,
            content: await encryptJson(financeCipher(ctx), payload)
        });
        const row = await ctx.repo.findCategory(id, ctx.workspaceId);
        if (!row) throw new FeatureError('internal', 'Catégorie introuvable après création');
        return { category: toCategory(row, payload) };
    }
});

export const financeCategoryUpdateFeature = defineSdkFeature({
    ...financeCategoryUpdate,
    mutates: true,
    access: WRITE,
    handler: async (ctx: Ctx, input) => {
        const existing = await ctx.repo.findCategory(input.categoryId, ctx.workspaceId);
        if (!existing) throw new FeatureError('not_found', 'Catégorie introuvable');

        // Changer le sens rendrait fausses toutes les opérations déjà classées dessous.
        if (existing.flow !== input.category.flow) {
            throw new FeatureError(
                'validation',
                'Le sens d’une catégorie ne se change pas. Créez-en une autre et déplacez les opérations.'
            );
        }

        const payload: StoredCategory = { name: input.category.name.trim() };
        const updated = await ctx.repo.updateCategory(input.categoryId, ctx.workspaceId, {
            flow: input.category.flow,
            color: input.category.color,
            icon: input.category.icon,
            content: await encryptJson(financeCipher(ctx), payload)
        });
        if (!updated) throw new FeatureError('not_found', 'Catégorie introuvable');
        const row = await ctx.repo.findCategory(input.categoryId, ctx.workspaceId);
        if (!row) throw new FeatureError('not_found', 'Catégorie introuvable');
        return { category: toCategory(row, payload) };
    }
});

export const financeCategoryRemoveFeature = defineSdkFeature({
    ...financeCategoryRemove,
    mutates: true,
    access: WRITE,
    handler: async (ctx: Ctx, input) => {
        const existing = await ctx.repo.findCategory(input.categoryId, ctx.workspaceId);
        if (!existing) throw new FeatureError('not_found', 'Catégorie introuvable');
        // Les opérations retombent dans « Sans catégorie » (`ON DELETE SET NULL`),
        // le budget part avec elle (`ON DELETE CASCADE`).
        await ctx.repo.deleteCategory(input.categoryId, ctx.workspaceId);
        ctx.audit({
            action: 'finance.categoryRemove',
            description: 'Catégorie supprimée',
            metadata: { categoryId: input.categoryId }
        });
        return { categoryId: input.categoryId };
    }
});

export const financeCategoryReorderFeature = defineSdkFeature({
    ...financeCategoryReorder,
    mutates: true,
    access: WRITE,
    handler: async (ctx: Ctx, input) => {
        const owned = new Set((await ctx.repo.listCategories(ctx.workspaceId)).map((row) => row.id));
        const categoryIds = input.categoryIds.filter((id) => owned.has(id));
        await ctx.repo.reorderCategories(ctx.workspaceId, categoryIds);
        return { categoryIds };
    }
});
