import { GIT_ITEMS_PROVIDER, type GitItemsProvider } from '@deveye/types/sdk';
import type { FeatureServer, SdkCipher } from '@deveye/types/sdk/server';

import { gitHandlers } from './handlers';
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
        // Le domicile seulement, jamais une projection : un projet relie ce que
        // son espace possède, et un identifiant étranger ne doit pas trahir son
        // existence en se laissant relier.
        const items: GitItemsProvider = {
            exists: async (repoId, workspaceId) => (await deps.repo.findRepo(repoId, workspaceId)) !== null,
            labelOf: (repoId, workspaceId) => labelOf(deps.repo, deps.cipherFor(workspaceId), repoId, workspaceId)
        };
        return {
            start() {
                setSync(sync);
                sync.start();
            },
            stop() {
                sync.stop();
                setSync(null);
            },
            providers: { [GIT_ITEMS_PROVIDER]: items }
        };
    },
    items: {
        homeOf: async (repo, itemId, workspaceId) =>
            (await repo.findVisibleRepo(itemId, workspaceId))?.workspace_id ?? null,
        labelOf
    }
};
