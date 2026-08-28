import { UPTIME_ITEMS_PROVIDER, type UptimeItemsProvider } from '@deveye/types/sdk';
import type { FeatureServer, SdkCipher } from '@deveye/types/sdk/server';

import { uptimeHandlers } from './handlers';
import { setMonitor } from './_shared';
import { createRepo, type UptimeRepo } from './repo';
import { UptimeMonitor } from './service';

/**
 * Le nom d'un service (la première clé du blob chiffré à l'étage ouvert),
 * déchiffré par `cipher` (le codec OUVERT de `workspaceId`, son domicile).
 * Un service disparu ou un blob illisible vaut `null`, jamais une exception :
 * ce que l'écran des canaux montre comme « une cible disparue », et une
 * fenêtre sur un projet projeté comme une liaison sans nom.
 *
 * Une seule fonction pour les deux appelants : l'entrée `items` (le codec de
 * l'espace appelant, fourni par l'app) et le contrat offert à Projets
 * (`deps.cipherFor(workspaceId)`).
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
 * L'entrée serveur du module.
 *
 * `createService` recompose ce que le boot natif faisait : l'ordonnanceur
 * (sondes, incidents, notifications) démarré avec un premier tour immédiat,
 * l'élagage horaire des pings bruts (l'ancien bloc du balayage de rétention
 * d'`index.ts`, devenu un ticker du module), le singleton posé pour les
 * handlers (`uptime.add`, `uptime.checkNow`), et le contrat offert à Projets
 * (`UPTIME_ITEMS_PROVIDER` : un service existe-t-il dans cet espace, et
 * comment s'appelle-t-il ?).
 *
 * `items` est ce que le partage et les routes de notification savent des
 * services sans ouvrir la feature : le domicile d'un service visible d'ici
 * (le sien, ou l'espace qui le projette), et son nom, déchiffré par le codec
 * ouvert de l'espace appelant. `shareTier: 'open'` l'exige ; le boot refuse
 * un module qui déclare sans l'offrir.
 *
 * Pas de `migrationsDir` : les tables d'Uptime datent du socle (037 et
 * suivantes, jamais déplacées, allowlist dans deveye-feature.json) ; une
 * nouvelle table inaugurera `src/server/migrations/` avec le préfixe
 * `ft_uptime_`.
 */
export const serverEntry: FeatureServer<UptimeRepo> = {
    createRepo,
    features: uptimeHandlers,
    createService(deps) {
        const monitor = new UptimeMonitor(deps);
        // Projets ne stocke que des identifiants ; avant d'en relier un, il
        // demande si le service existe dans l'espace (le sien : c'est ce que
        // faisait `uptimeServices.findById` avant le rapatriement), pour
        // qu'un identifiant étranger ne se relie pas et ne trahisse pas son
        // existence. Et le nom d'un service relié, sous le codec ouvert de son
        // domicile : ce qu'une fenêtre sur un projet projeté montre pour une
        // liaison qu'elle ne peut pas ouvrir, un nom, jamais un identifiant.
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
            (await repo.services.findVisible(itemId, workspaceId))?.workspace_id ?? null,
        labelOf
    }
};
