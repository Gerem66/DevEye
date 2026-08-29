import { AUDIENCE_ITEMS_PROVIDER, type AudienceItemsProvider } from '@deveye/types/sdk';
import type { FeatureServer, SdkCipher } from '@deveye/types/sdk/server';

import { audienceHandlers } from './handlers';
import { createRepo, type AudienceRepo } from './repo';
import { audienceRoutes } from './routes';
import { AudienceIngest } from './service';
import { readJson, setIngest, type StoredSite } from './_shared';

/**
 * Le nom d'un site, déchiffré par le codec ouvert de `workspaceId`, son
 * domicile. Un site disparu ou un blob illisible vaut `null` et jamais une
 * exception : l'appelant l'affiche comme une cible disparue.
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
 * `createService` monte l'ingestion des visites (file en mémoire, vidange par
 * lots, agrégat journalier, rétention), pose son singleton pour les handlers,
 * offre à Projets le contrat `AUDIENCE_ITEMS_PROVIDER`, et déclare les routes
 * publiques que l'hôte installe sur chacun de ses écouteurs exposés.
 *
 * `items` est ce que le partage sait des sites sans ouvrir la feature : le
 * domicile d'un site visible d'ici et son nom, sous le codec ouvert de l'espace
 * appelant. `shareTier: 'open'` l'exige, et le boot refuse un module qui
 * déclare sans l'offrir.
 *
 * Pas de `migrationsDir` : les tables du module datent du socle (allowlist dans
 * `deveye-feature.json`) ; une nouvelle table inaugurera `src/server/migrations/`
 * avec le préfixe `ft_audience_`.
 */
export const serverEntry: FeatureServer<AudienceRepo> = {
    createRepo,
    features: audienceHandlers,
    createService(deps) {
        const ingest = new AudienceIngest(deps);
        // Projets ne stocke que des identifiants : avant d'en relier un, il demande si
        // le site existe dans l'espace, pour qu'un identifiant étranger ne se relie pas
        // et ne trahisse pas son existence. Le domicile seulement, jamais une
        // projection : un projet relie ce que son espace possède.
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
            // Les mêmes trois routes à chaque appel ; c'est l'écouteur qui change.
            publicRoutes: (app) => audienceRoutes(app, ingest)
        };
    },
    items: {
        homeOf: async (repo, itemId, workspaceId) =>
            (await repo.findVisible(itemId, workspaceId))?.workspace_id ?? null,
        labelOf
    }
};
