import { workspaceAdd } from '@deveye/types';
import { invalidateAccess } from '../_access';
import { defineFeature, FeatureError, type FeatureDefinition } from '../_define';

const OWNED_WORKSPACES_MAX = 50;

/**
 * Crée un espace partagé dont l'appelant devient propriétaire. Le repo l'y
 * inscrit comme membre dans la foulée — sans quoi il ne verrait pas l'espace
 * qu'il vient de créer.
 */
export const workspaceAddFeature: FeatureDefinition<
    typeof workspaceAdd.command,
    typeof workspaceAdd.input,
    typeof workspaceAdd.output
> = defineFeature({
    ...workspaceAdd,
    mutates: true,
    handler: async (ctx, input) => {
        const owner = await ctx.db.users.findById(ctx.userId);
        if (!owner) throw new FeatureError('auth_invalid', 'Compte introuvable');
        // Chaque espace naît avec une clé et des lignes ; sans plafond, un compte
        // pourrait en semer sans fin. Assez large pour ne jamais gêner un usage
        // réel, trop bas pour servir de boucle.
        const owned = (await ctx.db.workspaces.findAccessibleByUser(ctx.userId)).filter(
            (w) => w.owner_user_id === ctx.userId && w.kind === 'shared'
        );
        if (owned.length >= OWNED_WORKSPACES_MAX) {
            throw new FeatureError('conflict', `Vous possédez déjà ${OWNED_WORKSPACES_MAX} espaces partagés`);
        }

        const workspace = await ctx.db.workspaces.create({
            ownerUserId: ctx.userId,
            name: input.name.trim()
        });

        // L'espace naît avec sa propre clé : tout espace partagé en a une, et
        // c'est ici, et ici seulement, qu'elle est posée.
        await ctx.secretKeys.createWorkspaceDek(workspace.id);

        // L'appelant vient de gagner un accès : les scopes mémoïsés doivent être
        // rebâtis pour que le nouvel espace soit adressable.
        invalidateAccess();

        ctx.audit({
            action: 'workspace.create',
            description: `Espace créé : « ${workspace.name} »`,
            metadata: { createdWorkspaceId: workspace.id }
        });

        return {
            workspace: {
                id: workspace.id,
                kind: workspace.kind,
                name: workspace.name,
                logo: workspace.logo,
                ownerUserId: workspace.owner_user_id,
                users: [
                    {
                        id: owner.id,
                        email: owner.email,
                        username: owner.username,
                        avatar: owner.avatar,
                        color: owner.color,
                        lastLogin: Number(owner.last_login),
                        created: Number(owner.created)
                    }
                ],
                features: [],
                created: Number(workspace.created)
            }
        };
    }
});
