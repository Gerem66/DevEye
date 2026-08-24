import { userSetColor } from '@deveye/types';
import { defineFeature, type FeatureDefinition } from '../_define';

/**
 * Couleur d'identité du compte, montrée aux autres membres en direct.
 *
 * `scope: 'account'` : c'est une propriété du compte et non de l'espace, donc
 * elle se change depuis n'importe où sans que l'enveloppe puisse la détourner.
 *
 * Conséquence de ce même `scope` : la diffusion `mutates` viserait l'espace
 * **personnel** de l'appelant, où il est seul. C'est donc `colorChanged` qui
 * porte la nouvelle teinte, en rediffusant le roster de toutes les salles où ce
 * compte a une connexion — la seule voie vivante, la copie livrée par la session
 * restant périmée jusqu'au prochain `/me`.
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
