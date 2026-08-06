import { workspaceDelete } from 'deveye-types';
import { invalidateAccess } from '../_access';
import { defineFeature, FeatureError, type FeatureDefinition } from '../_define';

/**
 * Supprime un espace partagé, avec tout ce qu'il contient (les FK ON DELETE
 * CASCADE emportent membres, notes, mots de passe…).
 *
 * Réservé au **propriétaire** : être membre ne suffit pas à détruire le travail
 * des autres. Un espace personnel n'est jamais supprimable — il disparaît avec
 * son compte, pas avant.
 */
export const workspaceDeleteFeature: FeatureDefinition<
    typeof workspaceDelete.command,
    typeof workspaceDelete.input,
    typeof workspaceDelete.output
> = defineFeature({
    ...workspaceDelete,
    mutates: true,
    handler: async (ctx, input) => {
        const target = await ctx.db.workspaces.findById(input.workspaceId);
        if (!target) throw new FeatureError('not_found', 'Espace introuvable');

        if (target.kind === 'personal') {
            throw new FeatureError('forbidden', 'L’espace personnel ne peut pas être supprimé');
        }
        if (target.owner_user_id !== ctx.userId) {
            throw new FeatureError('forbidden', 'Seul le propriétaire peut supprimer cet espace');
        }

        await ctx.db.workspaces.delete(target.id);

        // L'accès de tous les membres vient de disparaître.
        invalidateAccess();
        ctx.live?.evictRoom(target.id);

        ctx.audit({
            action: 'workspace.delete',
            level: 'warning',
            description: `Espace supprimé : « ${target.name} »`,
            metadata: { deletedWorkspaceId: target.id }
        });
        return { workspaceId: target.id };
    }
});
