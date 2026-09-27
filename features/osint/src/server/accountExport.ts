import type { FeatureAccountExport } from '@deveye/types/sdk/server';

import type { OsintRepo } from './repo';

export const osintAccountExport: FeatureAccountExport<OsintRepo> = {
    tables: {
        osint_lookups: {
            file: 'recherches.json',
            where: 'workspace_id = ?',
            key: ['created', 'id'],
            sealed: ['query_enc'],
            dates: { created: 's' }
        },
        ft_osint_usage: { file: 'recherches-par-mois.json', where: 'workspace_id = ?', key: ['month'] },
        osint_provider_keys: { skip: 'Les clés d’API des sources de recherche ne sortent jamais.' }
    }
};
