import { liveHere, livePathGate, segmentKind, segmentValue, type LivePath } from '@deveye/types';
import { defineFeature, FeatureError, type FeatureContext, type FeatureDefinition } from '../_define';

/**
 * Le lieu qu'une connexion a le droit d'occuper. C'est le client qui le
 * déclare : sans la lecture de la fonctionnalité de sa racine il retombe à
 * l'accueil, et sur un élément fermé à son rôle, à la vue. Autrement il
 * recevrait les curseurs et les bulles de ceux qui s'y trouvent.
 */
async function allowedPath(ctx: FeatureContext, path: LivePath): Promise<LivePath> {
    const gate = livePathGate(path[0]);
    if (gate === 'public' || gate === 'private') return path;
    if (!ctx.canFeature(gate)) return [];
    const item = path[1];
    if (item === undefined || segmentKind(item) !== 'l1') return path;
    const access = (await ctx.itemRestrictions(gate)).get(segmentValue(item));
    return access === 'none' ? path.slice(0, 1) : path;
}

/**
 * Déclare le lieu de cette connexion, et rend l'instantané de la salle. Aucune
 * garde `access` : le dispatcheur a déjà vérifié l'appartenance à l'espace de
 * l'enveloppe, et le lieu se borne ici à ce que l'appelant peut lire. La réponse
 * porte le roster : aucun trou entre l'inscription et la première diffusion, et
 * une reconnexion se resynchronise par ce seul appel.
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
        return { peers: ctx.live.here(ctx.workspaceId, await allowedPath(ctx, input.path), me.color) };
    }
});
