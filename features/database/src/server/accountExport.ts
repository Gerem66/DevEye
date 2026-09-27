import type { FeatureAccountExport } from '@deveye/types/sdk/server';

import type { DatabaseRepo } from './repo';

export const databaseAccountExport: FeatureAccountExport<DatabaseRepo> = {
    tables: {
        // Le mot de passe de la base et celui du tunnel ne sortent pas, le reste de l'accès si.
        database_connections: {
            file: 'bases.json',
            where: 'workspace_id = ?',
            key: ['id'],
            sealed: ['content', 'access_content', 'last_error'],
            json: ['content', 'access_content'],
            dates: { last_check_at: 's', created: 's' },
            omit: ['secret_enc', 'access_secret_enc']
        },
        database_alerts: {
            file: 'alertes.json',
            where: 'workspace_id = ?',
            key: ['id'],
            sealed: ['content', 'last_error'],
            json: ['content'],
            dates: { last_check_at: 's', last_fired_at: 's', created: 's' }
        }
    }
};
