import { userSetSetting } from '@deveye/types';
import { parseStringArray } from '../../auth/loadUserBundle';
import { defineFeature, type FeatureDefinition } from '../_define';

/**
 * Pose ou retire un drapeau de compte dans `users.settings`.
 *
 * `scope: 'account'` : ces drapeaux appartiennent au compte et non à l'espace,
 * donc ils se changent depuis n'importe où — le profil est ouvrable quel que
 * soit l'espace courant.
 *
 * La diffusion `mutates` viserait ici l'espace **personnel** de l'appelant, où
 * il est seul : elle est donc inerte, et c'est très bien. Un drapeau est privé
 * — personne d'autre n'a à l'apprendre — et le client applique la valeur
 * lui-même par `updateUser`, sans attendre de rafraîchissement. Contrairement à
 * la couleur (`setColor`), il n'y a donc rien à rediffuser en direct.
 *
 * L'écriture est une lecture-modification-écriture sur le sac entier plutôt
 * qu'une opération JSON en SQL : le sac est minuscule, et deux onglets d'un même
 * compte ne basculent pas deux drapeaux à la milliseconde près.
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
        // Le `Set` dédoublonne au passage : une base ayant hérité d'un doublon
        // (écriture concurrente d'une version antérieure) se nettoie toute seule
        // à la première bascule.
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
