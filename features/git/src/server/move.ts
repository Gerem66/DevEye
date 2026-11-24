import {
    countMovableCells,
    FeatureError,
    itemDigestTaken,
    movableCellsOf,
    rekeyItemDigests,
    resealCells,
    type FeatureItemsMove
} from '@deveye/types/sdk/server';

import type { GitRepo } from './repo';
import { gitTree } from './copy';

/**
 * Le changement d'espace d'un dépôt : sa fiche et tout son cache (commits,
 * branches, releases, pull requests, auteurs). Le jeton appartient à l'espace
 * quitté et ne suit pas : le dépôt arrive sans lui, donc sans synchronisation,
 * état que la feature sait déjà dire (`credential_id NULL`).
 *
 * Les cellules à resceller viennent de l'arbre de `copy.ts`, la seule liste à tenir.
 */
const CELLS = movableCellsOf(gitTree);

/** Les tables du cache qui portent leur propre espace, et doivent suivre. */
const OWNED_TABLES = ['git_commits', 'git_branches', 'git_releases', 'git_pull_requests', 'git_commit_authors'];

export const gitMove: FeatureItemsMove<GitRepo> = {
    async plan({ q, itemId, toWorkspaceId, cipher, keys }) {
        const repoId = Number(itemId);
        // `owner/repo` est unique par espace (`uniq_git_repo`), par un condensé lié
        // à l'espace : celui de l'arrivée se calcule avant d'écrire quoi que ce soit.
        const taken = await itemDigestTaken(q, gitTree, repoId, { cipher, keys, workspaceId: toWorkspaceId });
        const blockers = taken ? ['Ce dépôt est déjà suivi dans cet espace.'] : [];
        const rows = await q.query<{ credential_id: number | null }>(
            'SELECT credential_id FROM git_repos WHERE id = ?',
            [repoId]
        );
        return {
            blockers,
            drops:
                rows[0]?.credential_id != null
                    ? [
                          'Son jeton, qui appartient à cet espace : la synchronisation s’arrêtera jusqu’à ce qu’on en rattache un'
                      ]
                    : [],
            rows: await countMovableCells(q, CELLS, repoId)
        };
    },

    async apply({ q, itemId, fromWorkspaceId, toWorkspaceId, ciphers, keys }) {
        const repoId = Number(itemId);
        await resealCells(q, CELLS, repoId, ciphers);
        // Seul le condensé du dépôt dépend de l'espace : ceux du cache, liés au dépôt, le suivent tels quels.
        await rekeyItemDigests(
            q,
            gitTree,
            repoId,
            { cipher: ciphers.to, keys, workspaceId: toWorkspaceId },
            { within: 'workspace' }
        );
        // Chaque table du cache porte son propre `workspace_id` : sans elles,
        // le dépôt arriverait vide et son historique resterait derrière.
        for (const table of OWNED_TABLES) {
            await q.execute(`UPDATE ${table} SET workspace_id = ? WHERE repo_id = ? AND workspace_id = ?`, [
                toWorkspaceId,
                repoId,
                fromWorkspaceId
            ]);
        }
        const next = await q.query<{ next: number }>(
            'SELECT COALESCE(MAX(sort_order) + 1, 0) AS next FROM git_repos WHERE workspace_id = ?',
            [toWorkspaceId]
        );
        const res = await q.execute(
            `UPDATE git_repos SET workspace_id = ?, credential_id = NULL, sort_order = ?
              WHERE id = ? AND workspace_id = ?`,
            [toWorkspaceId, Number(next[0]?.next ?? 0), repoId, fromWorkspaceId]
        );
        if (res.affectedRows !== 1) {
            throw new FeatureError('not_found', 'Ce dépôt n’est plus dans cet espace : déplacement annulé.');
        }
    }
};
