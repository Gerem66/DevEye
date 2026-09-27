import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { AUDIENCE_ITEMS_PROVIDER, AUDIENCE_SELF_PROVIDER, type AudienceItemsProvider } from '@deveye/types/sdk';
import type { FeatureServer, SdkCipher } from '@deveye/types/sdk/server';

import { audienceAccountExport } from './accountExport';
import { audienceHandlers } from './handlers';
import { audienceCopy } from './copy';
import { audienceMove } from './move';
import { monthKey } from './normalize';
import { createRepo, type AudienceRepo } from './repo';
import { audienceRoutes } from './routes';
import { createSelfProvider } from './self';
import { AudienceIngest } from './service';
import { readJson, setIngest, type StoredSite } from './_shared';
import { audienceE2e } from './e2e';

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
 * Les sept tables de la mesure datent du socle (allowlist dans
 * `deveye-feature.json`) ; celles des retours appartiennent au module et
 * portent le préfixe `ft_audience_`, dans `src/server/migrations/`.
 */
export const serverEntry: FeatureServer<AudienceRepo> = {
    createRepo,
    e2e: audienceE2e,
    features: audienceHandlers,
    migrationsDir: path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations'),
    quotas: {
        sites: { list: (repo, owned) => repo.listStock(owned) },
        events: { count: (repo, owned) => repo.monthlyEvents(owned, monthKey(Math.floor(Date.now() / 1000))) }
    },
    createService(deps) {
        const ingest = new AudienceIngest(deps);
        // Projets ne stocke que des identifiants : avant d'en relier un, il demande si
        // le site est visible de l'espace, chez lui ou projeté, pour qu'un identifiant
        // étranger ne se relie pas et ne trahisse pas son existence. Le nom se lit
        // sous le codec du domicile, seul à savoir l'ouvrir.
        const items: AudienceItemsProvider = {
            exists: async (siteId, workspaceId) => (await deps.repo.findVisible(siteId, workspaceId)) !== null,
            labelOf: async (siteId, workspaceId) => {
                const row = await deps.repo.findVisible(siteId, workspaceId);
                return row ? labelOf(deps.repo, deps.cipherFor(row.workspace_id), siteId, row.workspace_id) : null;
            }
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
            providers: { [AUDIENCE_ITEMS_PROVIDER]: items, [AUDIENCE_SELF_PROVIDER]: createSelfProvider(deps, ingest) },
            // Les mêmes quatre routes à chaque appel ; c'est l'écouteur qui change.
            publicRoutes: (app) => audienceRoutes(app, ingest)
        };
    },
    items: {
        homeOf: async (repo, itemId, workspaceId) =>
            (await repo.findVisible(Number(itemId), workspaceId))?.workspace_id ?? null,
        labelOf: (repo, cipher, itemId, workspaceId) => labelOf(repo, cipher, Number(itemId), workspaceId),
        move: audienceMove,
        copy: audienceCopy
    },
    accountExport: audienceAccountExport
};
