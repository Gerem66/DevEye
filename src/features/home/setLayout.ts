import { homeSetLayout } from 'deveye-types';
import { defineFeature, type FeatureDefinition } from '../_define';

/**
 * Disposition de l'accueil de l'espace : commune à tous ses membres, donc
 * gardée par `workspace.layout`. Le propriétaire l'a d'office.
 */
export const homeSetLayoutFeature: FeatureDefinition<
    typeof homeSetLayout.command,
    typeof homeSetLayout.input,
    typeof homeSetLayout.output
> = defineFeature({
    ...homeSetLayout,
    mutates: true,
    access: { capabilities: ['workspace.layout'] },
    handler: async (ctx, input) => {
        await ctx.db.workspaces.setHomeLayout(ctx.workspaceId, JSON.stringify(input));
        ctx.audit({ action: 'home.setLayout', level: 'debug', description: "Disposition d'accueil modifiée" });
        return { ok: true };
    }
});
