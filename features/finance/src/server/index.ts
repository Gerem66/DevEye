import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { FeatureServer } from '@deveye/types/sdk/server';

import { FINANCE_ENV } from './env';
import { financeExternalServices } from './externalServices';
import { financeHandlers } from './handlers';
import { createRepo, type FinanceRepo } from './repo';
import { createService } from './service';
import { financeAccountExport } from './accountExport';

/**
 * Les tables datent du socle (`084_finance.sql`) ; `migrations/` porte leurs
 * évolutions. Le service fait les rappels de déclaration et relève les
 * connexions bancaires : le livre, lui, se tient à la lecture (voir `catchUp`).
 */
export const serverEntry: FeatureServer<FinanceRepo> = {
    env: FINANCE_ENV,
    createRepo,
    features: financeHandlers,
    accountExport: financeAccountExport,
    externalServices: financeExternalServices,
    migrationsDir: path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations'),
    createService,
    quotas: { bankConnections: { list: (repo, owned) => repo.listStockConnections(owned) } }
};
