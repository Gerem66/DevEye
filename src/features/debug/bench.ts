import { debugBenchCatalog, debugBenchStart, debugPing } from '@deveye/types';

import { debugHost } from '@/Services/debug';
import { defineFeature } from '../_define';
import { ADMIN } from './access';
import { launcherOf } from './launcher';

export const debugBenchCatalogFeature = defineFeature({
    ...debugBenchCatalog,
    access: ADMIN,
    handler: async () => ({ probes: debugHost().bench.catalog() })
});

export const debugBenchStartFeature = defineFeature({
    ...debugBenchStart,
    access: ADMIN,
    handler: async (ctx, input) => {
        const runId = await debugHost().bench.start(await launcherOf(ctx), input.profile, input.client);
        ctx.audit({ action: 'debug.benchStart', level: 'info', description: `Mesure ${runId} lancée` });
        return { runId };
    }
});

export const debugPingFeature = defineFeature({
    ...debugPing,
    access: ADMIN,
    handler: async () => ({ at: Date.now() })
});
