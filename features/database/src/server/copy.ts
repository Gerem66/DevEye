import type { FeatureItemsCopy, ItemTree } from '@deveye/types/sdk/server';

import type { DatabaseRepo } from './repo';

/**
 * Ce dont une base est faite : sa connexion, et ses alertes. C'est la liste que
 * le déplacement rescelle et que la copie emporte.
 *
 * ⚠️ À tenir à jour : toute nouvelle colonne chiffrée suspendue à une base doit
 * y figurer (`sealed`), sinon un déplacement la laisse sous l'ancienne clé, où
 * elle devient illisible, et une copie l'emporte sous une clé que la destination
 * n'a pas. Rien ne peut le détecter, un blob chiffré est indistinguable d'un
 * autre.
 */
export const databaseTree: ItemTree = [
    {
        table: 'database_connections',
        idColumn: 'id',
        ownerColumn: 'id',
        workspaceColumn: 'workspace_id',
        orderColumn: 'sort_order',
        // Le nom est unique par espace, par un condensé (`nameRef`) : il voyage
        // tel quel, n'étant dérivé que du nom.
        unique: { column: 'name_ref', message: 'Une base du même nom existe déjà dans cet espace.' },
        sealed: ['content', 'secret_enc', 'access_content', 'access_secret_enc', 'last_error'],
        omit: [
            'last_check_at',
            'last_elapsed_ms',
            'status',
            'last_error',
            'server_version',
            'size_bytes',
            'table_count',
            'created'
        ]
    },
    {
        table: 'database_alerts',
        idColumn: 'id',
        ownerColumn: 'database_id',
        workspaceColumn: 'workspace_id',
        sealed: ['content', 'last_error'],
        omit: ['firing', 'last_check_at', 'last_fired_at', 'last_error', 'created']
    }
];

export const databaseCopy: FeatureItemsCopy<DatabaseRepo> = {
    tree: databaseTree,
    async admit({ repo, quota }) {
        await quota.assert('connections', async (owned) => (await repo.countInWorkspaces(owned)) + 1);
    }
};
