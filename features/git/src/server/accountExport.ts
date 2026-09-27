import type { FeatureAccountExport } from '@deveye/types/sdk/server';

import type { GitRepo } from './repo';

export const gitAccountExport: FeatureAccountExport<GitRepo> = {
    tables: {
        // `sync_state` n'est que l'état de reprise de la synchronisation (ETags, dernier commit vu).
        git_repos: {
            file: 'depots.json',
            where: 'workspace_id = ?',
            key: ['id'],
            sealed: ['content', 'last_sync_error'],
            json: ['content'],
            dates: { last_sync_at: 's', created: 's' },
            omit: ['sync_state'],
            keep: ['credential_id']
        },
        ft_git_credentials: {
            file: 'jetons.json',
            where: 'workspace_id = ?',
            key: ['id'],
            dates: { created: 's' },
            omit: ['secret_enc']
        },
        git_commits: {
            skip: 'Les commits importés restent chez le fournisseur Git, d’où la synchronisation les relit.'
        },
        git_branches: {
            skip: 'Les branches importées restent chez le fournisseur Git, d’où la synchronisation les relit.'
        },
        git_commit_authors: {
            skip: 'Les auteurs des commits viennent de l’historique importé, que la synchronisation relit chez le fournisseur Git.'
        },
        git_pull_requests: {
            skip: 'Les demandes de fusion importées restent chez le fournisseur Git, d’où la synchronisation les relit.'
        },
        git_releases: {
            skip: 'Les versions importées restent chez le fournisseur Git, d’où la synchronisation les relit.'
        }
    }
};
