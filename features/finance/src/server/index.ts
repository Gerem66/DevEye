import type { FeatureServer } from '@deveye/types/sdk/server';

import { financeHandlers } from './handlers';
import { createRepo, type FinanceRepo } from './repo';

/**
 * L'entrée serveur du module. Pas de `migrationsDir` : les tables des Finances
 * datent du socle (084) et n'en bougeront jamais ; une nouvelle table du
 * module inaugurera `src/server/migrations/` avec le préfixe `ft_finance_`.
 *
 * Pas de `createService` non plus : les échéances n'ont aucune tâche de fond,
 * par choix (voir `postDueRecurring` dans `_shared.ts`).
 */
export const serverEntry: FeatureServer<FinanceRepo> = {
    createRepo,
    features: financeHandlers
};
