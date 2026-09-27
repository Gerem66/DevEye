import { debugE2eCatalog, debugE2eStart, debugE2eSweep } from '@deveye/types';

import { debugHost } from '@/Services/debug';
import { defineFeature } from '../_define';
import { ADMIN } from './access';
import { launcherOf } from './launcher';

export const debugE2eCatalogFeature = defineFeature({
    ...debugE2eCatalog,
    access: ADMIN,
    handler: async () => debugHost().e2e.catalog()
});

export const debugE2eStartFeature = defineFeature({
    ...debugE2eStart,
    access: ADMIN,
    handler: async (ctx, input) => {
        const runId = await debugHost().e2e.start(await launcherOf(ctx), input.scenarios);
        ctx.audit({
            action: 'debug.e2eStart',
            level: 'info',
            description: `Essai de bout en bout ${runId} lancé : ${input.scenarios.join(', ')}`
        });
        return { runId };
    }
});

export const debugE2eSweepFeature = defineFeature({
    ...debugE2eSweep,
    access: ADMIN,
    handler: async (ctx) => {
        const accounts = await debugHost().e2e.sweep(await launcherOf(ctx));
        ctx.audit({
            action: 'debug.e2eSweep',
            level: 'info',
            description: `Ménage des essais : ${accounts} compte(s) d’essai supprimé(s)`
        });
        return { accounts };
    }
});
