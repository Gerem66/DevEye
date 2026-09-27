import { userExportPreview } from '@deveye/types';

import { defineFeature, type FeatureDefinition } from '../_define';
import { moduleExportParts } from '../_sdk/register';

/** Ce que pèsera l'export des données du compte, partie par partie : de quoi choisir avant de donner son mot de passe. */
export const userExportPreviewFeature: FeatureDefinition<
    typeof userExportPreview.command,
    typeof userExportPreview.input,
    typeof userExportPreview.output
> = defineFeature({
    ...userExportPreview,
    access: { scope: 'account' },
    handler: async (ctx) => {
        const owned = await ctx.db.workspaces.listOwnedIds(ctx.userId);
        const accessible = await ctx.db.workspaces.findAccessibleByUser(ctx.userId);
        return {
            parts: await moduleExportParts(ctx.db, ctx.userId, owned),
            foreignWorkspaces: accessible.filter((w) => w.owner_user_id !== ctx.userId).length
        };
    }
});
