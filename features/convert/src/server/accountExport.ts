import type { FeatureAccountExport } from '@deveye/types/sdk/server';

import type { ConvertRepo } from './repo';

export const convertAccountExport: FeatureAccountExport<ConvertRepo> = {
    tables: {
        ft_convert_jobs: {
            file: 'conversions.json',
            where: 'workspace_id = ?',
            key: ['id'],
            sealed: ['original_name_enc', 'error_enc'],
            json: ['options'],
            dates: { created: 's', started_at: 's', finished_at: 's', expires_at: 's' }
        },
        ft_convert_fx_rates: { skip: 'Les taux de change sont publics et communs à tous les comptes.' },
        ft_convert_fx_state: { skip: 'L’avancée de la lecture des taux de change appartient au serveur.' }
    }
};
