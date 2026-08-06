import { userSetTheme } from 'deveye-types';
import { defineFeature, type FeatureDefinition } from '../_define';

export const userSetThemeFeature: FeatureDefinition<
    typeof userSetTheme.command,
    typeof userSetTheme.input,
    typeof userSetTheme.output
> = defineFeature({
    ...userSetTheme,
    mutates: true,
    handler: async (ctx, input) => {
        await ctx.db.workspaces.setTheme(ctx.workspaceId, JSON.stringify(input));
        ctx.audit({ action: 'user.setTheme', level: 'debug', description: 'Apparence modifiée' });
        return { ok: true };
    }
});
