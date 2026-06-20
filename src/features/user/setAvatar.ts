import { userSetAvatar } from 'deveye-types';
import { defineFeature, type FeatureDefinition } from '../_define';

export const userSetAvatarFeature: FeatureDefinition<
    typeof userSetAvatar.command,
    typeof userSetAvatar.input,
    typeof userSetAvatar.output
> = defineFeature({
    ...userSetAvatar,
    handler: async (ctx, input) => {
        await ctx.db.users.updateAvatar(ctx.userId, input.avatar);
        ctx.audit({ action: 'user.setAvatar', level: 'debug', description: 'Avatar modifié' });
        return { avatar: input.avatar };
    }
});
