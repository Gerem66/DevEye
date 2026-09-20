import { REMOTE_INSTANCES_MAX, remoteAdd, remoteList, remoteRemove, remoteRename, remoteReorder } from '@deveye/types';
import { toRemoteInstance as toInstance } from '@/db/repos/remoteInstances';
import { defineFeature, FeatureError, type FeatureContext } from '../_define';

/**
 * Les instances distantes du compte. Ce serveur n'en garde que l'adresse et le
 * libellé et ne contacte JAMAIS l'adresse : ni contrôle à l'ajout, ni sonde.
 * Tout ce qui parle à l'instance part du navigateur, sans quoi chaque compte
 * tiendrait une requête sortante vers l'hôte de son choix.
 */

/** Le menu des espaces des autres onglets du compte se relit avec la session. */
function menuChanged(ctx: FeatureContext): void {
    ctx.live?.userChanged(ctx.userId, ctx.workspaceId, ['workspace'], null);
}

const listFeature = defineFeature({
    ...remoteList,
    access: { scope: 'account' },
    handler: async (ctx) => ({ instances: (await ctx.db.remoteInstances.listByUser(ctx.userId)).map(toInstance) })
});

const addFeature = defineFeature({
    ...remoteAdd,
    access: { scope: 'account' },
    handler: async (ctx, input) => {
        if ((await ctx.db.remoteInstances.countByUser(ctx.userId)) >= REMOTE_INSTANCES_MAX) {
            throw new FeatureError('conflict', `Pas plus de ${REMOTE_INSTANCES_MAX} instances distantes par compte.`);
        }
        if (await ctx.db.remoteInstances.findByOrigin(ctx.userId, input.origin)) {
            throw new FeatureError('conflict', 'Cette instance est déjà dans votre liste.');
        }
        const row = await ctx.db.remoteInstances.create({
            userId: ctx.userId,
            label: input.label,
            origin: input.origin
        });
        // `warning` : l'adresse élargit la politique de contenu de la page de
        // ce compte, un ajout qu'il n'a pas fait doit se voir.
        ctx.audit({
            action: 'remote.add',
            level: 'warning',
            description: `Instance distante ajoutée : « ${row.label} » (${row.origin})`,
            metadata: { remoteInstanceId: row.id, origin: row.origin }
        });
        menuChanged(ctx);
        return { instance: toInstance(row) };
    }
});

const renameFeature = defineFeature({
    ...remoteRename,
    access: { scope: 'account' },
    handler: async (ctx, input) => {
        const row = await ctx.db.remoteInstances.findOwned(ctx.userId, input.id);
        if (!row) throw new FeatureError('not_found', 'Instance distante introuvable');
        await ctx.db.remoteInstances.rename(ctx.userId, row.id, input.label);
        menuChanged(ctx);
        return { instance: toInstance({ ...row, label: input.label }) };
    }
});

const removeFeature = defineFeature({
    ...remoteRemove,
    access: { scope: 'account' },
    handler: async (ctx, input) => {
        const row = await ctx.db.remoteInstances.findOwned(ctx.userId, input.id);
        if (!row) throw new FeatureError('not_found', 'Instance distante introuvable');
        await ctx.db.remoteInstances.remove(ctx.userId, row.id);
        ctx.audit({
            action: 'remote.remove',
            level: 'warning',
            description: `Instance distante retirée : « ${row.label} » (${row.origin})`,
            metadata: { remoteInstanceId: row.id, origin: row.origin }
        });
        menuChanged(ctx);
        return { id: row.id };
    }
});

const reorderFeature = defineFeature({
    ...remoteReorder,
    access: { scope: 'account' },
    handler: async (ctx, input) => {
        await ctx.db.remoteInstances.reorder(ctx.userId, input.ids);
        menuChanged(ctx);
        return { instances: (await ctx.db.remoteInstances.listByUser(ctx.userId)).map(toInstance) };
    }
});

export const remoteFeatures = [listFeature, addFeature, renameFeature, removeFeature, reorderFeature];
