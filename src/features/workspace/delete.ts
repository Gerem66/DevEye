import { workspaceDelete } from 'deveye-types';
import { defineFeature, FeatureError, type FeatureDefinition } from '../_define';

export const workspaceDeleteFeature: FeatureDefinition<
    typeof workspaceDelete.command,
    typeof workspaceDelete.input,
    typeof workspaceDelete.output
> = defineFeature({
    ...workspaceDelete,
    handler: async (ctx, input) => {
        if (input.workspaceId === 0) {
            throw new FeatureError('forbidden', 'The personal workspace cannot be deleted');
        }
        const isMember = await ctx.db.workspaceMembers.isMember(ctx.userId, input.workspaceId);
        if (!isMember) {
            throw new FeatureError('forbidden', 'Not a member of this workspace');
        }
        // FK ON DELETE CASCADE removes members + passwords.
        await ctx.db.workspaces.delete(input.workspaceId);
        return { workspaceId: input.workspaceId };
    }
});
