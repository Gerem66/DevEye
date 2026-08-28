import { DEPLOY_ITEMS_PROVIDER, type DeployItemsProvider } from '@deveye/types/sdk';
import type { FeatureServer } from '@deveye/types/sdk/server';

import { deployHandlers } from './handlers';
import { createRepo, type DeployRepo } from './repo';
import { DeploySync } from './service';
import { readJson, setSync, type StoredTarget } from './_shared';

/**
 * L'entrée serveur du module.
 *
 * `createService` recompose ce que le boot natif faisait : le rapprochement de
 * fond des cibles chez Dokploy (`DeploySync`, l'ex moitié déploiement de
 * `Services/IntegrationSyncService.ts`, qui garde la synchronisation git)
 * démarré avec les autres services, le singleton posé pour les handlers
 * (`deploy.trigger` réveille un tour), et le contrat offert à Projets
 * (`DEPLOY_ITEMS_PROVIDER` : une cible existe-t-elle dans cet espace ?).
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
        // relie ce que son espace possède.
        const items: DeployItemsProvider = {
            exists: async (targetId, workspaceId) => (await deps.repo.findTarget(targetId, workspaceId)) !== null
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
        // Le nom est la seule clé du blob chiffré à l'étage ouvert ; un blob
        // illisible ou une cible disparue vaut `null`, ce que l'écran des canaux
        // montre comme « une cible disparue ».
        labelOf: async (repo, cipher, itemId, workspaceId) => {
            const row = await repo.findTarget(itemId, workspaceId);
            if (!row) return null;
            const stored = await readJson<Partial<StoredTarget>>(cipher, row.content);
            return typeof stored?.name === 'string' && stored.name.length > 0 ? stored.name : null;
        }
    }
};
