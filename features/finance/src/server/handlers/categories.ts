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
 * Les catégories: la grille de lecture des dépenses et des recettes.
 *
 * Une catégorie ne sert **qu'un** sens (`flow`). « Salaire » ne classe pas une
 * dépense, et proposer les deux dans un seul sélecteur transformerait le choix
 * en fouille. C'est aussi ce qui rend une répartition lisible: additionner des
 * entrées et des sorties sous un même intitulé ne produit aucun nombre qui
 * veuille dire quelque chose.
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

        // Changer le sens d'une catégorie rendrait fausses toutes les opérations
        // déjà classées dessous: une dépense se retrouverait rangée sous une
        // catégorie de recettes, et la répartition compterait une sortie comme
        // une entrée. Le refus est franc, plutôt qu'une reclassification
        // silencieuse de l'historique.
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
        // Les opérations qu'elle classait retombent dans « Sans catégorie »
        // (`ON DELETE SET NULL`) et le budget posé dessus part avec elle
        // (`ON DELETE CASCADE`): une enveloppe sans catégorie ne veut plus rien
        // dire, une dépense sans catégorie reste une dépense.
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
