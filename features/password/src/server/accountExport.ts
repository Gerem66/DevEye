import type { FeatureAccountExport } from '@deveye/types/sdk/server';

import type { PasswordRepo } from './repo';

export const passwordAccountExport: FeatureAccountExport<PasswordRepo> = {
    tables: {
        passwords: {
            file: 'mots-de-passe.json',
            where: 'workspace_id = ?',
            key: ['id'],
            sealed: ['content'],
            json: ['content'],
            dates: { date: 's' }
        }
    }
};
