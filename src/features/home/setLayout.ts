import { homeSetLayout } from 'deveye-types';
import { defineFeature, type FeatureDefinition } from '../_define';

export const homeSetLayoutFeature: FeatureDefinition<
    typeof homeSetLayout.command,
    typeof homeSetLayout.input,
    typeof homeSetLayout.output
> = defineFeature({
    ...homeSetLayout,
    mutates: true,
    handler: async (ctx, input) => {
        await ctx.db.workspaces.setHomeLayout(ctx.workspaceId, JSON.stringify(input));
        ctx.audit({ action: 'home.setLayout', level: 'debug', description: "Disposition d'accueil modifiée" });
        return { ok: true };
    }
});
