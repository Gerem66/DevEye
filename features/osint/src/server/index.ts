import type { FeatureServer } from '@deveye/types/sdk/server';

import { osintHandlers } from './handlers';
import { createRepo, type OsintRepo } from './repo';

/**
 * L'entrée serveur du module. Pas de `migrationsDir` : les tables d'OSINT
 * datent du socle (075) et n'en bougeront jamais ; une nouvelle table du
 * module inaugurera `src/server/migrations/` avec le préfixe `ft_osint_`.
 */
export const serverEntry: FeatureServer<OsintRepo> = {
    createRepo,
    features: osintHandlers
};
