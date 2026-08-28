import { AUDIENCE_ITEMS_PROVIDER, type AudienceItemsProvider } from '@deveye/types/sdk';
import type { FeatureServer, SdkCipher } from '@deveye/types/sdk/server';

import { audienceHandlers } from './handlers';
import { createRepo, type AudienceRepo } from './repo';
import { audienceRoutes } from './routes';
import { AudienceIngest } from './service';
import { readJson, setIngest, type StoredSite } from './_shared';

/**
 * Le nom d'un site (la première clé du blob chiffré à l'étage ouvert),
 * déchiffré par `cipher` (le codec OUVERT de `workspaceId`, son domicile).
 * Un site disparu ou un blob illisible vaut `null`, jamais une exception : ce
 * que l'appelant montre comme « une cible disparue », qu'il soit l'app (le
 * partage) ou une fenêtre sur un projet projeté (une liaison qu'elle ne peut
 * pas ouvrir).
 *
 * Une seule fonction pour les deux appelants : l'entrée `items` (le codec de
 * l'espace appelant, fourni par l'app) et le contrat offert à Projets
 * (`deps.cipherFor(workspaceId)`).
 */
async function labelOf(
    repo: AudienceRepo,
    cipher: SdkCipher,
    siteId: number,
    workspaceId: number
): Promise<string | null> {
    const row = await repo.find(siteId, workspaceId);
    if (!row) return null;
    const stored = await readJson<Partial<StoredSite>>(cipher, row.content);
    return typeof stored?.name === 'string' && stored.name.length > 0 ? stored.name : null;
}

/**
 * L'entrée serveur du module.
 *
 * `createService` recompose ce que le boot natif faisait : l'ingestion des
 * visites (`AudienceIngest`, l'ex `Services/AudienceIngest.ts` : file en
 * mémoire, vidange par lots, agrégat journalier, rétention) démarrée avec les
 * autres services, le singleton posé pour les handlers (toute mutation d'un
 * site lui fait oublier son cache), le contrat offert à Projets
 * (`AUDIENCE_ITEMS_PROVIDER` : un site existe-t-il dans cet espace, et
 * comment s'appelle-t-il ?), et les **routes publiques** (`publicRoutes`,
 * capacité `routes.public`) : le script de mesure et les deux points d'entrée
 * des balises, que l'hôte monte sur chacun de ses écouteurs exposés, à la
 * place de l'ex `audienceRoutes(app)` que `app.ts` et `publicApp.ts`
 * appelaient chacun.
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
        // relie ce que son espace possède. Et le nom d'un site relié, sous le
        // codec ouvert de son domicile : ce qu'une fenêtre sur un projet projeté
        // montre pour une liaison qu'elle ne peut pas ouvrir, un nom, jamais un
        // identifiant.
        const items: AudienceItemsProvider = {
            exists: async (siteId, workspaceId) => (await deps.repo.find(siteId, workspaceId)) !== null,
            labelOf: (siteId, workspaceId) => labelOf(deps.repo, deps.cipherFor(workspaceId), siteId, workspaceId)
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
        labelOf
    }
};
