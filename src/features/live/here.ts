import { liveHere } from '@deveye/types';
import { defineFeature, FeatureError, type FeatureDefinition } from '../_define';

/**
 * Déclare le lieu de cette connexion, et rend l'instantané de la salle. Aucune
 * garde `access` : le dispatcheur a déjà vérifié l'appartenance à l'espace de
 * l'enveloppe. La réponse porte le roster : aucun trou entre l'inscription et
 * la première diffusion, et une reconnexion se resynchronise par ce seul appel.
 */
export const liveHereFeature: FeatureDefinition<
    typeof liveHere.command,
    typeof liveHere.input,
    typeof liveHere.output
> = defineFeature({
    ...liveHere,
    handler: async (ctx, input) => {
        if (!ctx.live) throw new FeatureError('internal', 'Connexion temps réel requise');
        // La couleur est lue au serveur plutôt que déclarée par le client : elle
        // fait partie du roster que les autres reçoivent.
        const me = await ctx.db.users.findById(ctx.userId);
        if (!me) throw new FeatureError('auth_invalid', 'Compte introuvable');
        return { peers: ctx.live.here(ctx.workspaceId, input.path, me.color) };
    }
});
