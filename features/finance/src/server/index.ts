import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { FeatureServer } from '@deveye/types/sdk/server';

import { financeHandlers } from './handlers';
import { createRepo, type FinanceRepo } from './repo';

/**
 * Les tables datent du socle (`084_finance.sql`) ; `migrations/` ne porte que
 * leurs évolutions. Pas de `createService` : les échéances n'ont aucune tâche
 * de fond (voir `postDueRecurring`).
 */
export const serverEntry: FeatureServer<FinanceRepo> = {
    createRepo,
    features: financeHandlers,
    migrationsDir: path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations')
};
