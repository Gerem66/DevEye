import { GIT_ITEMS_PROVIDER, type GitItemsProvider } from '@deveye/types/sdk';
import type { FeatureServer, SdkCipher } from '@deveye/types/sdk/server';

import { gitAccountExport } from './accountExport';
import { gitHandlers } from './handlers';
import { gitCopy } from './copy';
import { gitMove } from './move';
import { createRepo, type GitRepo } from './repo';
import { GitSync } from './service';
import { readJson, setSync, type StoredRepo } from './_shared';

/**
 * Le nom d'un dépôt (`owner/repo`), déchiffré par le codec ouvert de son
 * domicile. Un dépôt disparu ou un blob illisible vaut `null`, jamais une
 * exception : l'appelant le montre comme une cible disparue. Servie à l'entrée
 * `items` comme au contrat offert à Projets.
 */
async function labelOf(repo: GitRepo, cipher: SdkCipher, repoId: number, workspaceId: number): Promise<string | null> {
    const row = await repo.findRepo(repoId, workspaceId);
    if (!row) return null;
    const stored = await readJson<Partial<StoredRepo>>(cipher, row.content);
    return stored?.owner && stored.repo ? `${stored.owner}/${stored.repo}` : null;
}

/**
 * L'entrée serveur du module : la synchronisation de fond des dépôts chez GitHub
 * (`GitSync`), le singleton qu'elle pose pour les handlers, et le contrat offert
 * à Projets (un dépôt existe-t-il ici, et comment s'appelle-t-il ?).
 *
 * Pas de `migrationsDir` : les tables du module datent du socle (allowlist dans
 * `deveye-feature.json`) ; une nouvelle table inaugurera `src/server/migrations/`
 * avec le préfixe `ft_git_`.
 */
export const serverEntry: FeatureServer<GitRepo> = {
    createRepo,
    features: gitHandlers,
    createService(deps) {
        const sync = new GitSync(deps);
        // Visible d'ici, chez lui ou projeté : un projet relie ce que son espace
        // voit. Le nom se lit sous le codec du domicile, seul à savoir l'ouvrir.
        const items: GitItemsProvider = {
            exists: async (repoId, workspaceId) => (await deps.repo.findVisibleRepo(repoId, workspaceId)) !== null,
            labelOf: async (repoId, workspaceId) => {
                const row = await deps.repo.findVisibleRepo(repoId, workspaceId);
                return row ? labelOf(deps.repo, deps.cipherFor(row.workspace_id), repoId, row.workspace_id) : null;
            }
        };
        return {
            start() {
                setSync(sync);
                sync.start();
            },
            async stop() {
                await sync.stop();
                setSync(null);
            },
            providers: { [GIT_ITEMS_PROVIDER]: items }
        };
    },
    items: {
        homeOf: async (repo, itemId, workspaceId) =>
            (await repo.findVisibleRepo(Number(itemId), workspaceId))?.workspace_id ?? null,
        labelOf: (repo, cipher, itemId, workspaceId) => labelOf(repo, cipher, Number(itemId), workspaceId),
        move: gitMove,
        copy: gitCopy
    },
    quotas: { repos: { list: (repo, owned) => repo.listStockRepos(owned) } },
    accountExport: gitAccountExport
};
