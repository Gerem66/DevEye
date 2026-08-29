import { userSetSetting } from '@deveye/types';
import { parseStringArray } from '../../auth/loadUserBundle';
import { defineFeature, type FeatureDefinition } from '../_define';

/**
 * Pose ou retire un drapeau de compte dans `users.settings`. La diffusion
 * `mutates` vise l'espace personnel de l'appelant, où il est seul : inerte, et
 * c'est voulu, un drapeau est privé et le client applique la valeur lui-même.
 * Lecture-modification-écriture sur le sac entier : il est minuscule.
 */
export const userSetSettingFeature: FeatureDefinition<
    typeof userSetSetting.command,
    typeof userSetSetting.input,
    typeof userSetSetting.output
> = defineFeature({
    ...userSetSetting,
    mutates: true,
    access: { scope: 'account' },
    handler: async (ctx, input) => {
        const row = await ctx.db.users.findById(ctx.userId);
        const current = parseStringArray(row?.settings);
        // Le `Set` dédoublonne au passage.
        const next = new Set(current);
        if (input.enabled) next.add(input.flag);
        else next.delete(input.flag);

        const settings = [...next];
        await ctx.db.users.updateSettings(ctx.userId, settings);
        ctx.audit({
            action: 'user.setSetting',
            level: 'debug',
            description: `Réglage ${input.flag} ${input.enabled ? 'activé' : 'désactivé'}`
        });
        return { settings };
    }
});
