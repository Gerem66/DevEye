import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { APPSTORES_ITEMS_PROVIDER, type AppStoresItemsProvider } from '@deveye/types/sdk';
import { rekeyTreeDigests, type FeatureServer, type SdkCipher } from '@deveye/types/sdk/server';

import { appStoresAccountExport } from './accountExport';
import { appStoresCopy, appStoresTree } from './copy';
import { appStoresE2e } from './e2e';
import { appStoresHandlers } from './handlers';
import { appStoresMove } from './move';
import { createRepo, type AppStoresRepo } from './repo';
import { AppStoresSync } from './service';
import { readJson, setSync, type StoredApp } from './_shared';

/** Le nom d'une app sous le codec ouvert de son domicile ; `null` pour une app disparue ou illisible. */
async function labelOf(
    repo: AppStoresRepo,
    cipher: SdkCipher,
    appId: number,
    workspaceId: number
): Promise<string | null> {
    const row = await repo.findApp(appId, workspaceId);
    if (!row) return null;
    const stored = await readJson<Partial<StoredApp>>(cipher, row.content);
    return typeof stored?.name === 'string' && stored.name.length > 0 ? stored.name : null;
}

/**
 * L'entrée serveur du module : la synchronisation de fond (`AppStoresSync`),
 * le contrat offert à Projets, et `items`, ce que le partage sait d'une app
 * sans ouvrir la fonctionnalité (`shareTier: 'open'` l'exige).
 */
export const serverEntry: FeatureServer<AppStoresRepo> = {
    createRepo,
    features: appStoresHandlers,
    migrationsDir: path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations'),
    dataSteps: [
        {
            // Les condensés des fiches et des avis passent d'un SHA-256 nu à `keys.ref`.
            id: '001-keyed-refs',
            async run({ q, cipherFor, keys, logger }) {
                const pass = await rekeyTreeDigests(q, appStoresTree, { cipherFor, keys });
                // Une fiche illisible n'est plus reconnue : la même app peut être suivie une seconde fois dans son espace.
                if (pass.unreadable > 0 || pass.duplicates > 0) {
                    logger.error(
                        { unreadable: pass.unreadable, duplicates: pass.duplicates },
                        'Stores : des fiches ou des avis illisibles ou en double ont perdu leur condensé'
                    );
                }
            }
        }
    ],
    quotas: { apps: { list: (repo, owned) => repo.listStockApps(owned) } },
    createService(deps) {
        const sync = new AppStoresSync(deps);
        // Projets ne stocke que des identifiants : avant de relier une app, il
        // demande si elle est visible d'ici, et la nomme sous le codec de son domicile.
        const items: AppStoresItemsProvider = {
            exists: async (appId, workspaceId) => (await deps.repo.findVisibleApp(appId, workspaceId)) !== null,
            labelOf: async (appId, workspaceId) => {
                const row = await deps.repo.findVisibleApp(appId, workspaceId);
                return row ? labelOf(deps.repo, deps.cipherFor(row.workspace_id), appId, row.workspace_id) : null;
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
            providers: { [APPSTORES_ITEMS_PROVIDER]: items }
        };
    },
    items: {
        homeOf: async (repo, itemId, workspaceId) =>
            (await repo.findVisibleApp(Number(itemId), workspaceId))?.workspace_id ?? null,
        labelOf: (repo, cipher, itemId, workspaceId) => labelOf(repo, cipher, Number(itemId), workspaceId),
        move: appStoresMove,
        copy: appStoresCopy
    },
    accountExport: appStoresAccountExport,
    e2e: appStoresE2e
};
