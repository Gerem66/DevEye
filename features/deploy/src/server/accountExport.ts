import type { FeatureAccountExport } from '@deveye/types/sdk/server';

import type { DeployRepo } from './repo';

export const deployAccountExport: FeatureAccountExport<DeployRepo> = {
    tables: {
        deploy_targets: {
            file: 'cibles.json',
            where: 'workspace_id = ?',
            key: ['id'],
            sealed: ['content'],
            json: ['content'],
            dates: { synced_at: 's', created: 's' },
            keep: ['credential_id']
        },
        deployments: {
            file: 'deploiements.json',
            where: 'workspace_id = ?',
            key: ['id'],
            sealed: ['content'],
            json: ['content'],
            dates: { started_at: 's', finished_at: 's' }
        },
        ft_deploy_credentials: {
            file: 'acces.json',
            where: 'workspace_id = ?',
            key: ['id'],
            dates: { created: 's' },
            omit: ['secret_enc']
        }
    }
};
