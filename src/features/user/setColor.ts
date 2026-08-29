import { userSetColor } from '@deveye/types';
import { defineFeature, type FeatureDefinition } from '../_define';

/**
 * Couleur d'identité du compte, montrée aux autres membres en direct. Avec
 * `scope: 'account'`, la diffusion `mutates` viserait l'espace personnel de
 * l'appelant, où il est seul : c'est `colorChanged` qui porte la nouvelle
 * teinte à toutes les salles où ce compte a une connexion.
 */
export const userSetColorFeature: FeatureDefinition<
    typeof userSetColor.command,
    typeof userSetColor.input,
    typeof userSetColor.output
> = defineFeature({
    ...userSetColor,
    mutates: true,
    access: { scope: 'account' },
    handler: async (ctx, input) => {
        await ctx.db.users.updateColor(ctx.userId, input.color);
        ctx.live?.colorChanged(input.color);
        ctx.audit({ action: 'user.setColor', level: 'debug', description: 'Couleur de présence modifiée' });
        return { color: input.color };
    }
});
