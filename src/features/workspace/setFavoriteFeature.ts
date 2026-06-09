import { workspaceSetFavoriteFeature } from 'deveye-types';
import { defineFeature, FeatureError, type FeatureDefinition } from '../_define';

export const workspaceSetFavoriteFeatureFeature: FeatureDefinition<
    typeof workspaceSetFavoriteFeature.command,
    typeof workspaceSetFavoriteFeature.input,
    typeof workspaceSetFavoriteFeature.output
> = defineFeature({
    ...workspaceSetFavoriteFeature,
    handler: async (ctx, input) => {
        if (input.workspaceId > 0) {
            const isMember = await ctx.db.workspaceMembers.isMember(ctx.userId, input.workspaceId);
            if (!isMember) {
                throw new FeatureError('forbidden', 'Not a member of this workspace');
            }
        }
        await ctx.db.users.setDefaults(ctx.userId, {
            defaultWorkspace: input.workspaceId,
            defaultFeature: input.featureId
        });
        return { workspaceId: input.workspaceId, featureId: input.featureId };
    }
});
