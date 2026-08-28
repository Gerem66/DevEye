import { DEPLOY_ITEMS_PROVIDER, type DeployItemsProvider } from '@deveye/types/sdk';
import type { FeatureServer, SdkCipher } from '@deveye/types/sdk/server';

import { deployHandlers } from './handlers';
import { createRepo, type DeployRepo } from './repo';
import { DeploySync } from './service';
import { readJson, setSync, type StoredTarget } from './_shared';

/**
 * Le nom d'une cible (la seule clé du blob chiffré à l'étage ouvert),
 * déchiffré par `cipher` (le codec OUVERT de `workspaceId`, son domicile).
 * Une cible disparue ou un blob illisible vaut `null`, jamais une exception :
 * ce que l'écran des canaux montre comme « une cible disparue », et une
 * fenêtre sur un projet projeté comme une liaison sans nom.
 *
 * Une seule fonction pour les deux appelants : l'entrée `items` (le codec de
 * l'espace appelant, fourni par l'app) et le contrat offert à Projets
 * (`deps.cipherFor(workspaceId)`).
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
 * L'entrée serveur du module.
 *
 * `createService` recompose ce que le boot natif faisait : le rapprochement de
 * fond des cibles chez Dokploy (`DeploySync`, l'ex moitié déploiement de
 * `Services/IntegrationSyncService.ts`, qui garde la synchronisation git)
 * démarré avec les autres services, le singleton posé pour les handlers
 * (`deploy.trigger` réveille un tour), et le contrat offert à Projets
 * (`DEPLOY_ITEMS_PROVIDER` : une cible existe-t-elle dans cet espace, et
 * comment s'appelle-t-elle ?).
 *
 * Déploiement a **ses propres** canaux (`notification_channels`, feature
 * `deploy`) : le service notifie par la façade `notify` du SDK, sur la route
 * de chaque cible, et le message vivant d'un déploiement passe par la même
 * façade (`liveChannels`, `postLive`).
 *
 * `items` est ce que le partage et les routes de notification savent des
 * cibles sans ouvrir la feature : le domicile d'une cible visible d'ici (la
 * sienne, ou l'espace qui la projette), et son nom, déchiffré par le codec
 * ouvert de l'espace appelant. `shareTier: 'open'` l'exige ; le boot refuse
 * un module qui déclare sans l'offrir.
 *
 * Pas de `migrationsDir` : les deux tables historiques du module datent du
 * socle (080, complétée par la 085, jamais déplacées, allowlist dans
 * deveye-feature.json), et `ft_deploy_credentials` a été créée et remplie par
 * la 099 du socle (les clés devaient quitter `workspace_credentials`, une table
 * du socle qu'une migration de module ne peut pas toucher) ; une nouvelle table
 * inaugurera `src/server/migrations/` avec le préfixe `ft_deploy_`.
 * `project_deploy_links` (080) appartient à Projets.
 */
export const serverEntry: FeatureServer<DeployRepo> = {
    createRepo,
    features: deployHandlers,
    createService(deps) {
        const sync = new DeploySync(deps);
        // Projets ne stocke que des identifiants ; avant d'en relier un, il
        // demande si la cible existe dans l'espace (le sien : c'est ce que
        // faisait `deploy.findTarget` avant le rapatriement), pour qu'un
        // identifiant étranger ne se relie pas et ne trahisse pas son
        // existence. Le domicile seulement, jamais une projection : un projet
        // relie ce que son espace possède. Et le nom d'une cible reliée, sous le
        // codec ouvert de son domicile : ce qu'une fenêtre sur un projet projeté
        // montre pour une liaison qu'elle ne peut pas ouvrir, un nom, jamais un
        // identifiant.
        const items: DeployItemsProvider = {
            exists: async (targetId, workspaceId) => (await deps.repo.findTarget(targetId, workspaceId)) !== null,
            labelOf: (targetId, workspaceId) => labelOf(deps.repo, deps.cipherFor(workspaceId), targetId, workspaceId)
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
            (await repo.findVisibleTarget(itemId, workspaceId))?.workspace_id ?? null,
        labelOf
    }
};
