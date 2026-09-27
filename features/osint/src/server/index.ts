import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { FeatureServer } from '@deveye/types/sdk/server';

import { OSINT_LOOKUP_QUOTA } from '../contracts/domain';
import { osintHandlers } from './handlers';
import { createRepo, type OsintRepo } from './repo';
import { osintAccountExport } from './accountExport';
import { monthKey } from './usage';

/** Les tables historiques sont dans le socle ; celles du module, préfixées `ft_osint_`, dans `migrations/`. */
export const serverEntry: FeatureServer<OsintRepo> = {
    createRepo,
    migrationsDir: path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations'),
    features: osintHandlers,
    accountExport: osintAccountExport,
    quotas: { [OSINT_LOOKUP_QUOTA]: { count: (repo, owned) => repo.lookupsIn(owned, monthKey()) } }
};
