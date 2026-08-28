import { GIT_ITEMS_PROVIDER, type GitItemsProvider } from '@deveye/types/sdk';
import type { FeatureServer, SdkCipher } from '@deveye/types/sdk/server';

import { gitHandlers } from './handlers';
import { createRepo, type GitRepo } from './repo';
import { GitSync } from './service';
import { readJson, setSync, type StoredRepo } from './_shared';

/**
 * Le nom d'un dépôt (`owner/repo`, les deux clés du blob chiffré à l'étage
 * ouvert), déchiffré par `cipher` (le codec OUVERT de `workspaceId`, son
 * domicile). Un dépôt disparu ou un blob illisible vaut `null`, jamais une
 * exception : ce que l'appelant montre comme « une cible disparue », qu'il
 * soit l'app (le partage) ou une fenêtre sur un projet projeté (une liaison
 * qu'elle ne peut pas ouvrir).
 *
 * Une seule fonction pour les deux appelants : l'entrée `items` (le codec de
 * l'espace appelant, fourni par l'app) et le contrat offert à Projets
 * (`deps.cipherFor(workspaceId)`).
 */
async function labelOf(repo: GitRepo, cipher: SdkCipher, repoId: number, workspaceId: number): Promise<string | null> {
    const row = await repo.findRepo(repoId, workspaceId);
    if (!row) return null;
    const stored = await readJson<Partial<StoredRepo>>(cipher, row.content);
    return stored?.owner && stored.repo ? `${stored.owner}/${stored.repo}` : null;
}

/**
 * L'entrée serveur du module.
 *
 * `createService` recompose ce que le boot natif faisait : la synchronisation
 * de fond des dépôts chez GitHub (`GitSync`, l'ex moitié git de
 * `Services/IntegrationSyncService.ts`, dont Déploiement avait déjà emporté
 * l'autre moitié) démarrée avec les autres services, le singleton posé pour
 * les handlers (`git.repoAdd`, `git.repoSyncNow` et `git.repoResync`
 * réveillent un tour ; `git.repoSyncStatus` et `git.syncStatuses` lisent son
 * avancement en mémoire), et le contrat offert à Projets (`GIT_ITEMS_PROVIDER` :
 * un dépôt existe-t-il dans cet espace, et comment s'appelle-t-il ?).
 *
 * Git ne notifie personne (`notifies: false`) : aucune capacité `notify`, et
 * ce qu'il dit à Projets (la version d'un projet qui suit une release) passe
 * par le contrat que Projets lui offre (`PROJECTS_USAGE_PROVIDER.applyVersion`).
 *
 * `items` est ce que le partage sait des dépôts sans ouvrir la feature : le
 * domicile d'un dépôt visible d'ici (le sien, ou l'espace qui le projette), et
 * son nom (`owner/repo`), déchiffré par le codec ouvert de l'espace appelant.
 * `shareTier: 'open'` l'exige ; le boot refuse un module qui déclare sans
 * l'offrir.
 *
 * Pas de `migrationsDir` : les six tables historiques du module datent du
 * socle (064, complétées par la 065 et la 069, jamais déplacées, allowlist
 * dans deveye-feature.json), et `ft_git_credentials` a été créée et remplie
 * par la 100 du socle (les jetons devaient quitter `workspace_credentials`,
 * une table du socle qu'une migration de module ne peut pas toucher, et qui
 * n'existe plus) ; une nouvelle table inaugurera `src/server/migrations/`
 * avec le préfixe `ft_git_`. `project_repo_links` (064) appartient à Projets.
 */
export const serverEntry: FeatureServer<GitRepo> = {
    createRepo,
    features: gitHandlers,
    createService(deps) {
        const sync = new GitSync(deps);
        // Projets ne stocke que des identifiants ; avant d'en relier un, il
        // demande si le dépôt existe dans l'espace (le sien : c'est ce que
        // faisait `git.findRepo` avant le rapatriement), pour qu'un
        // identifiant étranger ne se relie pas et ne trahisse pas son
        // existence. Le domicile seulement, jamais une projection : un projet
        // relie ce que son espace possède. Et le nom d'un dépôt relié, sous le
        // codec ouvert de son domicile : ce qu'une fenêtre sur un projet projeté
        // montre pour une liaison qu'elle ne peut pas ouvrir, un nom, jamais un
        // identifiant.
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
