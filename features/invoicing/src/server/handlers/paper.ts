import { defineSdkFeature } from '@deveye/types/sdk/server';

import { invoicingPaper } from '../../contracts/commands';
import { renderPaper } from '../paper';
import { paperInputOf } from '../paperInput';
import { assertClient, docOr404, type Ctx } from '../_shared';

export const paper = defineSdkFeature({
    ...invoicingPaper,
    handler: async (ctx: Ctx, input) => {
        const row = await docOr404(ctx, input.id);
        await assertClient(ctx, row.client_id, 'read');
        return { html: renderPaper(await paperInputOf(ctx, row)) };
    }
});

export const paperHandlers = [paper];
