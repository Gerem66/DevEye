import type { FeatureServer } from '@deveye/types/sdk/server';

import { osintHandlers } from './handlers';
import { createRepo, type OsintRepo } from './repo';

/**
 * Pas de `migrationsDir` : les tables d'OSINT sont dans le socle ; une nouvelle
 * table irait dans `src/server/migrations/` avec le préfixe `ft_osint_`.
 */
export const serverEntry: FeatureServer<OsintRepo> = {
    createRepo,
    features: osintHandlers
};
