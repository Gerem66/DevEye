import { defineSdkFeature, FeatureError } from '@deveye/types/sdk/server';

import { invoicingShare } from '../../contracts/commands';
import { assertClient, docOr404, publicOriginOf, settingsOf, WRITE, type Ctx } from '../_shared';
import { newToken } from '../service';

/**
 * Le lien public. Il naît avec l'émission, puisque c'est par lui que le document
 * est remis ; on ne passe ici que pour le révoquer, ou pour en refaire un après
 * l'avoir révoqué.
 */
export const share = defineSdkFeature({
    ...invoicingShare,
    access: WRITE,
    mutates: true,
    handler: async (ctx: Ctx, input) => {
        const row = await docOr404(ctx, input.id);
        await assertClient(ctx, row.client_id, 'write');

        if (input.revoke) {
            await ctx.repo.setToken(row.id, ctx.workspaceId, null);
            return { url: null };
        }

        if (row.status === 'draft') {
            throw new FeatureError(
                'conflict',
                'Un brouillon ne se partage pas : émettez-le d’abord, il aura alors son numéro.'
            );
        }

        // Un jeton déjà posé se réutilise : régénérer casserait le lien déjà
        // envoyé, et le client tomberait sur une page disparue.
        const token = row.public_token ?? newToken();
        if (row.public_token === null) await ctx.repo.setToken(row.id, ctx.workspaceId, token);

        return { url: `${await publicOriginOf(ctx, await settingsOf(ctx))}/f/${encodeURIComponent(token)}` };
    }
});

export const shareHandlers = [share];
