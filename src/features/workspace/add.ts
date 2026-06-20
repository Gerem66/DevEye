import { workspaceAdd } from 'deveye-types';
import { defineFeature, type FeatureDefinition } from '../_define';

export const workspaceAddFeature: FeatureDefinition<
    typeof workspaceAdd.command,
    typeof workspaceAdd.input,
    typeof workspaceAdd.output
> = defineFeature({
    ...workspaceAdd,
    handler: async (ctx, input) => {
        const workspace = await ctx.db.workspaces.create({ name: input.name });
        await ctx.db.workspaceMembers.add({
            userId: ctx.userId,
            workspaceId: workspace.id,
            roles: ['owner']
        });

        ctx.audit({
            action: 'workspace.create',
            description: `Espace de travail créé : « ${workspace.name} »`,
            metadata: { workspaceId: workspace.id }
        });

        return {
            workspace: {
                id: workspace.id,
                name: workspace.name,
                logo: workspace.logo,
                users: [],
                features: [],
                reAuthInterval: workspace.re_auth_interval,
                created: Number(workspace.created)
            }
        };
    }
});
