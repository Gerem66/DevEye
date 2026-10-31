import { debugLoadStart } from '@deveye/types';

import { debugHost } from '@/Services/debug';
import { defineFeature } from '../_define';
import { ADMIN } from './access';
import { launcherOf } from './launcher';

export const debugLoadStartFeature = defineFeature({
    ...debugLoadStart,
    access: ADMIN,
    handler: async (ctx, input) => {
        const runId = await debugHost().load.start(await launcherOf(ctx), input);
        ctx.audit({
            action: 'debug.loadStart',
            level: 'info',
            description: `Montée en charge ${runId} lancée : ${input.users} utilisateurs sur ${input.durationMin} min`
        });
        return { runId };
    }
});
