import { cloudSyncListEvents } from 'deveye-types';

import { defineFeature } from '../_define';
import { authorizeShare, toClientEvent } from './_shared';

export const cloudSyncListEventsFeature = defineFeature({
    ...cloudSyncListEvents,
    handler: async (ctx, input) => {
        const share = await authorizeShare(ctx, input.shareId);
        const [rows, total] = await Promise.all([
            ctx.db.syncEvents.list(share.id, input.limit, input.offset),
            ctx.db.syncEvents.count(share.id)
        ]);
        return { events: rows.map(toClientEvent), total };
    }
});
