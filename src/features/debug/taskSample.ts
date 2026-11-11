import { setTimeout as delay } from 'node:timers/promises';

import { debugTaskSample } from '@deveye/types';

import { defineFeature, FeatureError } from '../_define';
import { ADMIN } from './access';

const STEP_MS = 250;

/** Une commande lente qui ne fait rien : ce que la galerie lance pour montrer une opération suivie. */
export const debugTaskSampleFeature = defineFeature({
    ...debugTaskSample,
    access: ADMIN,
    handler: async (ctx, input) => {
        const steps = (input.seconds * 1000) / STEP_MS;
        for (let step = 1; step <= steps; step++) {
            await delay(STEP_MS);
            if (!input.quiet) ctx.progress?.({ done: step, total: steps, step: 'Essai en cours' });
        }
        // Un refus ordinaire : `internal` alerterait l'instance pour un échec demandé.
        if (input.fail) throw new FeatureError('conflict', 'Échec demandé par l’essai.');
        return { steps };
    }
});
