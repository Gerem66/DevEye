import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { FeatureServer } from '@deveye/types/sdk/server';

import { pdfAccountExport } from './accountExport';
import { pdfE2e } from './e2e';
import { pdfHandlers } from './handlers';
import { createRepo, type PdfRepo } from './repo';

/** Aucun service, aucune route : le serveur ne garde que les signatures du compte. */
export const serverEntry: FeatureServer<PdfRepo> = {
    createRepo,
    features: pdfHandlers,
    accountExport: pdfAccountExport,
    e2e: pdfE2e,
    migrationsDir: path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations')
};
