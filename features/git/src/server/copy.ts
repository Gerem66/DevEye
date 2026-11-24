import type { FeatureItemsCopy, ItemTree, ItemTreeDigest } from '@deveye/types/sdk/server';

import { AUTHOR_DIGEST, BRANCH_DIGEST, COMMIT_AUTHOR_DIGEST, SLUG_DIGEST, TAG_DIGEST } from './refs';
import type { GitRepo } from './repo';

/**
 * Ce dont un dépôt suivi est fait : sa ligne, et le cache que la synchronisation
 * reconstruit. C'est la liste que le déplacement rescelle et que la copie
 * emporte.
 *
 * ⚠️ À tenir à jour : toute nouvelle colonne chiffrée suspendue à un dépôt doit
 * y figurer (`sealed`), sinon un déplacement la laisse sous l'ancienne clé, où
 * elle devient illisible. Rien ne peut le détecter, un blob chiffré est
 * indistinguable d'un autre.
 */
const cache = (table: string, digests: readonly ItemTreeDigest[] = []) => ({
    table,
    idColumn: 'id',
    ownerColumn: 'repo_id',
    sealed: ['content'],
    cache: true,
    digests
});

export const gitTree: ItemTree = [
    {
        table: 'git_repos',
        idColumn: 'id',
        ownerColumn: 'id',
        workspaceColumn: 'workspace_id',
        orderColumn: 'sort_order',
        // `owner/repo` est unique par espace, par un condensé lié à cet espace :
        // il ne voyage pas, la destination calcule le sien.
        unique: { column: 'slug_ref', message: 'Ce dépôt est déjà suivi dans cet espace.' },
        digests: [SLUG_DIGEST],
        sealed: ['content', 'last_sync_error', 'sync_state'],
        // Le jeton est une source de l'espace quitté ; l'état de
        // synchronisation appartient à ce serveur.
        omit: ['credential_id', 'last_sync_at', 'last_sync_error', 'sync_state', 'created']
    },
    cache('git_commits', [COMMIT_AUTHOR_DIGEST]),
    cache('git_branches', [BRANCH_DIGEST]),
    cache('git_releases', [TAG_DIGEST]),
    cache('git_pull_requests'),
    cache('git_commit_authors', [AUTHOR_DIGEST])
];

export const gitCopy: FeatureItemsCopy<GitRepo> = {
    tree: gitTree,
    async plan({ q, itemId }) {
        const rows = await q.query<{ credential_id: number | null }>(
            'SELECT credential_id FROM git_repos WHERE id = ?',
            [Number(itemId)]
        );
        return {
            blockers: [],
            drops: [
                ...(rows[0]?.credential_id != null
                    ? ['Son jeton, qui appartient à cet espace : il faudra en rattacher un pour synchroniser']
                    : []),
                'Son historique déjà synchronisé, que la copie ira relire'
            ]
        };
    },
    async admit({ repo, quota }) {
        await quota.assert('repos', async (owned) => (await repo.countReposInWorkspaces(owned)) + 1);
    }
};
