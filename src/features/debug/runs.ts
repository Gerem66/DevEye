import { debugOverview, debugRunAbort, debugRunGet, debugRunList } from '@deveye/types';

import { debugHost } from '@/Services/debug';
import { defineFeature, FeatureError } from '../_define';
import { ADMIN } from './access';

export const debugOverviewFeature = defineFeature({
    ...debugOverview,
    access: ADMIN,
    handler: async () => {
        const host = debugHost();
        return { instance: host.instance(), activeRun: host.runs.active() };
    }
});

export const debugRunGetFeature = defineFeature({
    ...debugRunGet,
    access: ADMIN,
    handler: async (_ctx, input) => {
        const run = await debugHost().runs.get(input.runId);
        if (!run) throw new FeatureError('not_found', 'Essai introuvable');
        return run;
    }
});

export const debugRunListFeature = defineFeature({
    ...debugRunList,
    access: ADMIN,
    handler: async (_ctx, input) => ({ runs: await debugHost().runs.list(input.kind, input.limit) })
});

export const debugRunAbortFeature = defineFeature({
    ...debugRunAbort,
    access: ADMIN,
    handler: async (ctx, input) => {
        if (!debugHost().runs.abort(input.runId)) throw new FeatureError('not_found', 'Cet essai n’est plus en cours');
        ctx.audit({ action: 'debug.runAbort', level: 'warning', description: `Essai ${input.runId} arrêté` });
        return { runId: input.runId };
    }
});
