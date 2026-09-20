import type { FeatureItemsCopy, ItemTree } from '@deveye/types/sdk/server';

import type { DeployRepo } from './repo';

/**
 * Ce dont une cible est faite : sa ligne, et l'historique de ses déploiements.
 * C'est la liste que le déplacement rescelle et que la copie emporte.
 *
 * ⚠️ À tenir à jour : toute nouvelle colonne chiffrée suspendue à une cible doit
 * y figurer (`sealed`), sinon un déplacement la laisse sous l'ancienne clé, où
 * elle devient illisible. Rien ne peut le détecter, un blob chiffré est
 * indistinguable d'un autre.
 */
export const deployTree: ItemTree = [
    {
        table: 'deploy_targets',
        idColumn: 'id',
        ownerColumn: 'id',
        workspaceColumn: 'workspace_id',
        orderColumn: 'sort_order',
        sealed: ['content'],
        // Le jeton est une source de l'espace quitté : il ne suit pas.
        omit: ['credential_id', 'synced_at', 'created']
    },
    { table: 'deployments', idColumn: 'id', ownerColumn: 'target_id', sealed: ['content'], cache: true }
];

export const deployCopy: FeatureItemsCopy<DeployRepo> = {
    tree: deployTree,
    async plan({ q, itemId }) {
        const rows = await q.query<{ credential_id: number | null }>(
            'SELECT credential_id FROM deploy_targets WHERE id = ?',
            [Number(itemId)]
        );
        return {
            blockers: [],
            drops: [
                ...(rows[0]?.credential_id != null
                    ? ['Son jeton de déploiement, qui appartient à cet espace : la copie arrivera indéployable']
                    : []),
                'L’historique de ses déploiements'
            ]
        };
    }
};
