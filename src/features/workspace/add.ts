import { workspaceAdd } from 'deveye-types';
import { invalidateAccess } from '../_access';
import { defineFeature, FeatureError, type FeatureDefinition } from '../_define';

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

        const workspace = await ctx.db.workspaces.create({
            ownerUserId: ctx.userId,
            name: input.name.trim()
        });

        // L'espace naît avec sa propre clé. Il est vide, donc il n'y a rien à
        // convertir : seuls les espaces antérieurs à cette clé doivent passer par
        // `workspace.enableSharedKey`. C'est ce qui rend cet état transitoire —
        // une fois les anciens convertis, tout espace partagé a sa clé.
        await ctx.secretKeys.resolveWorkspaceDek(workspace.id);

        // L'appelant vient de gagner un accès : les scopes mémoïsés de sa
        // connexion doivent être rebâtis pour que le nouvel espace soit
        // immédiatement adressable.
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
