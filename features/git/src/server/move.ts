import {
    countMovableCells,
    FeatureError,
    resealCells,
    type FeatureItemsMove,
    type MovableCell,
    type SdkQueryable
} from '@deveye/types/sdk/server';

import type { GitRepo } from './repo';

/**
 * Le changement d'espace d'un dépôt : sa fiche et tout son cache (commits,
 * branches, releases, pull requests, auteurs). Le jeton appartient à l'espace
 * quitté et ne suit pas : le dépôt arrive sans lui, donc sans synchronisation,
 * état que la feature sait déjà dire (`credential_id NULL`).
 *
 * ⚠️ Liste à tenir à jour : toute nouvelle colonne chiffrée suspendue à un dépôt
 * doit y figurer, sinon son contenu reste sous l'ancienne clé et devient
 * illisible. Rien ne peut le détecter, un blob chiffré est indistinguable d'un
 * autre.
 */
const CELLS: readonly MovableCell[] = [
    { table: 'git_repos', idColumn: 'id', ownerColumn: 'id', column: 'content' },
    { table: 'git_repos', idColumn: 'id', ownerColumn: 'id', column: 'last_sync_error' },
    { table: 'git_repos', idColumn: 'id', ownerColumn: 'id', column: 'sync_state' },
    { table: 'git_commits', idColumn: 'id', ownerColumn: 'repo_id', column: 'content' },
    { table: 'git_branches', idColumn: 'id', ownerColumn: 'repo_id', column: 'content' },
    { table: 'git_releases', idColumn: 'id', ownerColumn: 'repo_id', column: 'content' },
    { table: 'git_pull_requests', idColumn: 'id', ownerColumn: 'repo_id', column: 'content' },
    { table: 'git_commit_authors', idColumn: 'id', ownerColumn: 'repo_id', column: 'content' }
];

/** Les tables du cache qui portent leur propre espace, et doivent suivre. */
const OWNED_TABLES = ['git_commits', 'git_branches', 'git_releases', 'git_pull_requests', 'git_commit_authors'];

/**
 * `owner/repo` est unique par espace (`uniq_git_repo`), porté par un condensé
 * puisque le chiffrement est non déterministe : la collision se décide sans rien
 * déchiffrer, et avant d'écrire.
 */
async function slugTaken(q: SdkQueryable, repoId: number, toWorkspaceId: number): Promise<boolean> {
    const rows = await q.query<{ n: number }>(
        `SELECT COUNT(*) AS n FROM git_repos
          WHERE workspace_id = ? AND slug_ref = (SELECT slug_ref FROM git_repos WHERE id = ?)`,
        [toWorkspaceId, repoId]
    );
    return Number(rows[0]?.n ?? 0) > 0;
}

export const gitMove: FeatureItemsMove<GitRepo> = {
    async plan({ q, itemId, toWorkspaceId }) {
        const repoId = Number(itemId);
        const blockers = (await slugTaken(q, repoId, toWorkspaceId))
            ? ['Ce dépôt est déjà suivi dans cet espace.']
            : [];
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

    async apply({ q, itemId, fromWorkspaceId, toWorkspaceId, ciphers }) {
        const repoId = Number(itemId);
        await resealCells(q, CELLS, repoId, ciphers);
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
