import type { FeatureServer } from '@deveye/types/sdk/server';

import { financeHandlers } from './handlers';
import { createRepo, type FinanceRepo } from './repo';

/**
 * Pas de `migrationsDir` : les tables datent du socle. Pas de `createService` :
 * les échéances n'ont aucune tâche de fond (voir `postDueRecurring`).
 */
export const serverEntry: FeatureServer<FinanceRepo> = {
    createRepo,
    features: financeHandlers
};
