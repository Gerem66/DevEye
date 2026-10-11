import { adminPending } from '@deveye/types';

import { adminPending as pendingService } from '@/Services/adminPending';
import { defineFeature, type FeatureDefinition } from '../_define';

export const adminPendingFeature: FeatureDefinition<
    typeof adminPending.command,
    typeof adminPending.input,
    typeof adminPending.output
> = defineFeature({
    ...adminPending,
    access: { moderation: true, scope: 'account' },
    handler: async (ctx) => pendingService.forViewer(ctx.isAdmin)
});
