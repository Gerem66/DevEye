import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { FeatureServer } from '@deveye/types/sdk/server';

import { financeHandlers } from './handlers';
import { createRepo, type FinanceRepo } from './repo';
import { createService } from './service';

/**
 * Les tables datent du socle (`084_finance.sql`) ; `migrations/` porte leurs
 * évolutions. Le service ne fait que les rappels de déclaration : le livre, lui,
 * se tient à la lecture (voir `catchUp`).
 */
export const serverEntry: FeatureServer<FinanceRepo> = {
    createRepo,
    features: financeHandlers,
    migrationsDir: path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations'),
    createService
};
