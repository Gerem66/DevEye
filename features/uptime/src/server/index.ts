import { UPTIME_ITEMS_PROVIDER, type UptimeItemsProvider } from '@deveye/types/sdk';
import type { FeatureServer, SdkCipher } from '@deveye/types/sdk/server';

import { uptimeHandlers } from './handlers';
import { setMonitor } from './_shared';
import { createRepo, type UptimeRepo } from './repo';
import { UptimeMonitor } from './service';

/**
 * Le nom d'un service, déchiffré par le codec ouvert de son espace. Un service
 * disparu ou un blob illisible vaut `null`, jamais une exception : l'écran des
 * canaux le montre comme une cible disparue.
 */
async function labelOf(
    repo: UptimeRepo,
    cipher: SdkCipher,
    serviceId: number,
    workspaceId: number
): Promise<string | null> {
    const row = await repo.services.findById(serviceId, workspaceId);
    if (!row) return null;
    const plain = await cipher.tryDecrypt(row.content);
    if (plain === null) return null;
    try {
        const parsed = JSON.parse(plain) as { name?: unknown };
        return typeof parsed.name === 'string' && parsed.name.length > 0 ? parsed.name : null;
    } catch {
        return null;
    }
}

/**
 * `items` : ce que le partage et les routes de notification savent des services
 * sans ouvrir la feature (domicile et nom). `shareTier: 'open'` l'exige.
 *
 * Pas de `migrationsDir` : les tables d'Uptime sont dans le socle ; une nouvelle
 * table irait dans `src/server/migrations/` avec le préfixe `ft_uptime_`.
 */
export const serverEntry: FeatureServer<UptimeRepo> = {
    createRepo,
    features: uptimeHandlers,
    createService(deps) {
        const monitor = new UptimeMonitor(deps);
        // Projets ne stocke que des identifiants : `exists` refuse de relier un
        // identifiant étranger (sans trahir son existence), `labelOf` donne un
        // nom à une liaison qu'une fenêtre projetée ne peut pas ouvrir.
        const items: UptimeItemsProvider = {
            exists: async (serviceId, workspaceId) =>
                (await deps.repo.services.findById(serviceId, workspaceId)) !== null,
            labelOf: (serviceId, workspaceId) => labelOf(deps.repo, deps.cipherFor(workspaceId), serviceId, workspaceId)
        };
        return {
            start() {
                setMonitor(monitor);
                monitor.start();
            },
            stop() {
                monitor.stop();
                setMonitor(null);
            },
            providers: { [UPTIME_ITEMS_PROVIDER]: items }
        };
    },
    items: {
        homeOf: async (repo, itemId, workspaceId) =>
            (await repo.services.findVisible(Number(itemId), workspaceId))?.workspace_id ?? null,
        labelOf: (repo, cipher, itemId, workspaceId) => labelOf(repo, cipher, Number(itemId), workspaceId)
    }
};
