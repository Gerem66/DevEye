import type { FeatureAccountExport } from '@deveye/types/sdk/server';

import type { CveRepo } from './repo';
import { NVD_KEY_STORE_KEY } from './_shared';

export const cveAccountExport: FeatureAccountExport<CveRepo> = {
    tables: {
        ft_cve_favorites: {
            file: 'epingles.json',
            where: 'workspace_id = ?',
            key: ['created', 'cve_id'],
            dates: { created: 's' }
        },
        ft_cve_entries: { skip: 'Le catalogue des vulnérabilités est public et commun à tous les comptes.' },
        ft_cve_state: { skip: 'L’avancée de la lecture du catalogue appartient au serveur.' }
    },
    store: { omit: [NVD_KEY_STORE_KEY] }
};
