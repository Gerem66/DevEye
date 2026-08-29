import { userSetTheme } from '@deveye/types';
import { defineFeature, type FeatureDefinition } from '../_define';

/**
 * Apparence de l'espace, pas du compte, malgré le préfixe `user` : tous les
 * membres la voient, d'où la capacité. Le sujet est explicite parce que
 * `mutates: true` déduirait `account` du préfixe, qui ne sort jamais de
 * l'espace personnel.
 */
export const userSetThemeFeature: FeatureDefinition<
    typeof userSetTheme.command,
    typeof userSetTheme.input,
    typeof userSetTheme.output
> = defineFeature({
    ...userSetTheme,
    mutates: ['home'],
    access: { capabilities: ['workspace.appearance'] },
    handler: async (ctx, input) => {
        await ctx.db.workspaces.setTheme(ctx.workspaceId, JSON.stringify(input));
        ctx.audit({ action: 'user.setTheme', level: 'debug', description: 'Apparence modifiée' });
        return { ok: true };
    }
});
