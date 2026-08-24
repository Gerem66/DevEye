import { liveHere } from '@deveye/types';
import { defineFeature, FeatureError, type FeatureDefinition } from '../_define';

/**
 * Déclare le lieu de cette connexion, et rend l'instantané de la salle.
 *
 * Aucune garde `access` n'est nécessaire, et c'est le point du dessin : l'espace
 * voyage sur l'enveloppe comme pour toute commande, donc le dispatcheur l'a déjà
 * résolu **et vérifié l'appartenance** avant d'arriver ici. Entrer dans la salle
 * d'un espace dont on n'est pas membre est donc impossible, sans une ligne de
 * plus.
 *
 * La réponse porte le roster — même motif que `cloudSync.subscribe` : il n'y a
 * aucun trou entre l'inscription et la première diffusion, et une reconnexion se
 * resynchronise par ce seul appel.
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
        // fait partie du roster que les autres reçoivent, et n'a donc pas à être
        // affirmée par celui qu'elle désigne.
        const me = await ctx.db.users.findById(ctx.userId);
        if (!me) throw new FeatureError('auth_invalid', 'Compte introuvable');
        return { peers: ctx.live.here(ctx.workspaceId, input.path, me.color) };
    }
});
