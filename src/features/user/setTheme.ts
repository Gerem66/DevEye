import { userSetTheme } from 'deveye-types';
import { defineFeature, type FeatureDefinition } from '../_define';

export const userSetThemeFeature: FeatureDefinition<
    typeof userSetTheme.command,
    typeof userSetTheme.input,
    typeof userSetTheme.output
> = defineFeature({
    ...userSetTheme,
    handler: async (ctx, input) => {
        await ctx.db.users.setTheme(ctx.userId, JSON.stringify(input));
        return { ok: true };
    }
});
