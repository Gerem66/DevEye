import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { FeatureServer } from '@deveye/types/sdk/server';

import { cveHandlers } from './handlers';
import { createRepo, type CveRepo } from './repo';
import { createService } from './service';

/**
 * Pas d'entrée `items` : `shareTier: 'never'`, une CVE est publique et n'a rien
 * à projeter d'un espace à l'autre.
 */
export const serverEntry: FeatureServer<CveRepo> = {
    createRepo,
    features: cveHandlers,
    migrationsDir: path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations'),
    createService: (deps) => createService(deps)
};
