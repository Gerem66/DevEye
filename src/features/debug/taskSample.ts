import { setTimeout as delay } from 'node:timers/promises';

import { debugTaskSample } from '@deveye/types';

import { tasks } from '@/Services/tasks';
import { defineFeature, FeatureError } from '../_define';
import { ADMIN } from './access';

const STEP_MS = 250;
const FAILURE = 'Échec demandé par l’essai.';

/**
 * Une commande lente qui ne fait rien : ce que la galerie lance pour montrer
 * une opération suivie. `background` rend la main tout de suite et laisse le
 * travail au serveur, comme le ferait le service d'une fonctionnalité.
 */
export const debugTaskSampleFeature = defineFeature({
    ...debugTaskSample,
    access: ADMIN,
    handler: async (ctx, input) => {
        const steps = (input.seconds * 1000) / STEP_MS;
        if (input.background) {
            let stopped = false;
            const task = tasks.openService({
                userId: ctx.userId,
                workspaceId: ctx.workspaceId,
                // L'id que la galerie donne à ses essais : son avancement en place les retrouve.
                feature: 'gallery',
                title: 'Essai mené par le serveur',
                subject: 'Galerie',
                cancel: () => {
                    stopped = true;
                },
                // Une commande d'administrateur : l'essai appartient à qui l'a lancé.
                allowed: () => Promise.resolve(true)
            });
            void (async () => {
                for (let step = 1; step <= steps && !stopped; step++) {
                    await delay(STEP_MS);
                    if (!input.quiet) task.progress({ done: step, total: steps, step: 'Essai en cours' });
                }
                if (stopped) task.cancelled();
                else if (input.fail) task.fail(FAILURE, 'conflict');
                else task.done('L’essai est allé au bout.');
            })();
            return { steps };
        }
        for (let step = 1; step <= steps; step++) {
            await delay(STEP_MS);
            if (!input.quiet) ctx.progress?.({ done: step, total: steps, step: 'Essai en cours' });
        }
        // Un refus ordinaire : `internal` alerterait l'instance pour un échec demandé.
        if (input.fail) throw new FeatureError('conflict', FAILURE);
        return { steps };
    }
});
