import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { FeatureServer } from '@deveye/types/sdk/server';

import { convertHandlers } from './handlers';
import { createRepo, type ConvertRepo } from './repo';
import { createService } from './service';

/** Pas d'entrée `items` : `shareTier: 'never'`, une conversion est personnelle et éphémère. */
export const serverEntry: FeatureServer<ConvertRepo> = {
    createRepo,
    features: convertHandlers,
    migrationsDir: path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations'),
    createService: (deps) => createService(deps)
};
