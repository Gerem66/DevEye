import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { FeatureServer } from '@deveye/types/sdk/server';

import { osintHandlers } from './handlers';
import { createRepo, type OsintRepo } from './repo';

/** Les tables historiques sont dans le socle ; celles du module, préfixées `ft_osint_`, dans `migrations/`. */
export const serverEntry: FeatureServer<OsintRepo> = {
    createRepo,
    migrationsDir: path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations'),
    features: osintHandlers
};
