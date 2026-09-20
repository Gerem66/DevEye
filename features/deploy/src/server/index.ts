import { DEPLOY_ITEMS_PROVIDER, type DeployItemsProvider } from '@deveye/types/sdk';
import type { FeatureServer, SdkCipher } from '@deveye/types/sdk/server';

import { deployHandlers } from './handlers';
import { deployCopy } from './copy';
import { deployMove } from './move';
import { createRepo, type DeployRepo } from './repo';
import { DeploySync } from './service';
import { readJson, setSync, type StoredTarget } from './_shared';

/**
 * Le nom d'une cible, déchiffré par `cipher` (le codec ouvert de son domicile).
 * Une cible disparue ou un blob illisible vaut `null`, jamais une exception.
 * Sert à l'entrée `items` et au contrat offert à Projets.
 */
async function labelOf(
    repo: DeployRepo,
    cipher: SdkCipher,
    targetId: number,
    workspaceId: number
): Promise<string | null> {
    const row = await repo.findTarget(targetId, workspaceId);
    if (!row) return null;
    const stored = await readJson<Partial<StoredTarget>>(cipher, row.content);
    return typeof stored?.name === 'string' && stored.name.length > 0 ? stored.name : null;
}

/**
 * L'entrée serveur du module : le rapprochement de fond des cibles chez Dokploy
 * (`DeploySync`, posé en singleton pour que `deploy.trigger` réveille un tour),
 * le contrat offert à Projets (`DEPLOY_ITEMS_PROVIDER`) et l'entrée `items`
 * qu'exige `shareTier: 'open'` (domicile et nom d'une cible visible d'ici).
 *
 * Pas de `migrationsDir` : `deploy_targets`, `deployments` et
 * `ft_deploy_credentials` datent du socle (allowlist dans deveye-feature.json) ;
 * une nouvelle table inaugurera `src/server/migrations/` avec le préfixe
 * `ft_deploy_`. `project_deploy_links` appartient à Projets.
 */
export const serverEntry: FeatureServer<DeployRepo> = {
    createRepo,
    features: deployHandlers,
    createService(deps) {
        const sync = new DeploySync(deps);
        // Projets ne stocke que des identifiants : il demande si la cible est
        // visible de son espace, chez elle ou projetée, pour qu'un identifiant
        // étranger ne se relie pas ; et son nom, sous le codec ouvert du
        // domicile, seul à savoir l'ouvrir.
        const items: DeployItemsProvider = {
            exists: async (targetId, workspaceId) =>
                (await deps.repo.findVisibleTarget(targetId, workspaceId)) !== null,
            labelOf: async (targetId, workspaceId) => {
                const row = await deps.repo.findVisibleTarget(targetId, workspaceId);
                return row ? labelOf(deps.repo, deps.cipherFor(row.workspace_id), targetId, row.workspace_id) : null;
            }
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
            providers: { [DEPLOY_ITEMS_PROVIDER]: items }
        };
    },
    items: {
        homeOf: async (repo, itemId, workspaceId) =>
            (await repo.findVisibleTarget(Number(itemId), workspaceId))?.workspace_id ?? null,
        labelOf: (repo, cipher, itemId, workspaceId) => labelOf(repo, cipher, Number(itemId), workspaceId),
        move: deployMove,
        copy: deployCopy
    }
};
