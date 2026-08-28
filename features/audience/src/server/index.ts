import { AUDIENCE_ITEMS_PROVIDER, type AudienceItemsProvider } from '@deveye/types/sdk';
import type { FeatureServer } from '@deveye/types/sdk/server';

import { audienceHandlers } from './handlers';
import { createRepo, type AudienceRepo } from './repo';
import { audienceRoutes } from './routes';
import { AudienceIngest } from './service';
import { readJson, setIngest, type StoredSite } from './_shared';

/**
 * L'entrée serveur du module.
 *
 * `createService` recompose ce que le boot natif faisait : l'ingestion des
 * visites (`AudienceIngest`, l'ex `Services/AudienceIngest.ts` : file en
 * mémoire, vidange par lots, agrégat journalier, rétention) démarrée avec les
 * autres services, le singleton posé pour les handlers (toute mutation d'un
 * site lui fait oublier son cache), le contrat offert à Projets
 * (`AUDIENCE_ITEMS_PROVIDER` : un site existe-t-il dans cet espace ?), et les
 * **routes publiques** (`publicRoutes`, capacité `routes.public`) : le script
 * de mesure et les deux points d'entrée des balises, que l'hôte monte sur
 * chacun de ses écouteurs exposés, à la place de l'ex `audienceRoutes(app)`
 * que `app.ts` et `publicApp.ts` appelaient chacun.
 *
 * Audience ne notifie personne (`notifies: false`) : aucune capacité `notify`.
 *
 * `items` est ce que le partage sait des sites sans ouvrir la feature : le
 * domicile d'un site visible d'ici (le sien, ou l'espace qui le projette), et
 * son nom, déchiffré par le codec ouvert de l'espace appelant. `shareTier:
 * 'open'` l'exige ; le boot refuse un module qui déclare sans l'offrir.
 *
 * Pas de `migrationsDir` : les sept tables historiques du module datent du
 * socle (076 et 078, jamais déplacées, allowlist dans deveye-feature.json) ;
 * une nouvelle table inaugurera `src/server/migrations/` avec le préfixe
 * `ft_audience_`. `project_audience_links` (077) appartient à Projets.
 */
export const serverEntry: FeatureServer<AudienceRepo> = {
    createRepo,
    features: audienceHandlers,
    createService(deps) {
        const ingest = new AudienceIngest(deps);
        // Projets ne stocke que des identifiants ; avant d'en relier un, il
        // demande si le site existe dans l'espace (le sien : c'est ce que
        // faisait `audience.find` avant le rapatriement), pour qu'un
        // identifiant étranger ne se relie pas et ne trahisse pas son
        // existence. Le domicile seulement, jamais une projection : un projet
        // relie ce que son espace possède.
        const items: AudienceItemsProvider = {
            exists: async (siteId, workspaceId) => (await deps.repo.find(siteId, workspaceId)) !== null
        };
        return {
            start() {
                setIngest(ingest);
                ingest.start();
            },
            async stop() {
                await ingest.stop();
                setIngest(null);
            },
            providers: { [AUDIENCE_ITEMS_PROVIDER]: items },
            // Les mêmes trois routes à chaque appel ; c'est l'écouteur qui
            // change (l'app, puis la surface publique quand elle existe).
            publicRoutes: (app) => audienceRoutes(app, ingest)
        };
    },
    items: {
        homeOf: async (repo, itemId, workspaceId) =>
            (await repo.findVisible(itemId, workspaceId))?.workspace_id ?? null,
        // Le nom est la première clé du blob chiffré à l'étage ouvert ; un blob
        // illisible ou un site disparu vaut `null`, ce que l'écran des canaux
        // montre comme « une cible disparue ».
        labelOf: async (repo, cipher, itemId, workspaceId) => {
            const row = await repo.find(itemId, workspaceId);
            if (!row) return null;
            const stored = await readJson<Partial<StoredSite>>(cipher, row.content);
            return typeof stored?.name === 'string' && stored.name.length > 0 ? stored.name : null;
        }
    }
};
