import type { FeatureServer } from '@deveye/types/sdk/server';

import { devicesAccountExport } from './accountExport';
import { devicesHandlers } from './handlers';
import { devicesMove } from './move';
import { createRepo, type DevicesRepo } from './repo';
import { RetentionSweep } from './service';
import { DEVICES_ENV } from './env';

/**
 * L'entrée serveur du module : le balayage horaire de rétention
 * (`RetentionSweep`) sur le dépôt du module, l'entrée `items` sans laquelle
 * un `shareTier` autre que `'never'` est refusé au démarrage, et la limite de
 * stock `agents`. Aucun hook agent (la télémétrie est ingérée par l'app, hors
 * session), aucune notification.
 *
 * Pas de `migrationsDir` : les cinq tables datent du socle (voir `repo/index.ts`
 * et l'allowlist de `deveye-feature.json`) ; une table propre au module
 * inaugurera `src/server/migrations/` avec le préfixe `ft_devices_`.
 */
export const serverEntry: FeatureServer<DevicesRepo> = {
    env: DEVICES_ENV,
    createRepo,
    features: devicesHandlers,
    createService(deps) {
        const sweep = new RetentionSweep(deps);
        return {
            start() {
                sweep.start();
            },
            stop() {
                return sweep.stop();
            },
            // La session d'un agent garde sa ligne d'appareil et continuerait
            // d'émettre : seule la fermeture l'arrête. La reprise n'a rien à
            // faire, l'agent se reconnecte de lui-même.
            onPlanPause(change) {
                if (change.key !== 'agents') return;
                for (const item of change.paused) deps.agents.disconnectAgent(item.id);
            }
        };
    },
    quotas: {
        agents: { list: (repo, owned) => repo.devices.listActiveInWorkspaces(owned) }
    },
    items: {
        homeOf: async (repo, itemId, workspaceId) =>
            (await repo.devices.findVisible(itemId, workspaceId))?.workspace_id ?? null,
        // Le nom d'un appareil est en clair : le codec ne sert pas ici.
        labelOf: async (repo, _cipher, itemId, workspaceId) =>
            (await repo.devices.findVisible(itemId, workspaceId))?.name ?? null,
        move: devicesMove
    },
    accountExport: devicesAccountExport
};
