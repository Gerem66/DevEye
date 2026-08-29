import type { FeatureServer } from '@deveye/types/sdk/server';

import { devicesHandlers } from './handlers';
import { createRepo, type DevicesRepo } from './repo';
import { RetentionSweep } from './service';

/**
 * L'entrée serveur du module : le balayage horaire de rétention
 * (`RetentionSweep`) sur le dépôt du module. Aucun hook agent (la télémétrie
 * est ingérée par l'app, hors session), aucun provider, aucune notification.
 *
 * Pas de `migrationsDir` : les six tables datent du socle (voir `repo/index.ts`
 * et l'allowlist de `deveye-feature.json`) ; une table propre au module
 * inaugurera `src/server/migrations/` avec le préfixe `ft_devices_`. Pas
 * d'entrée `items` : `shareTier: 'never'`, le partage d'un appareil est le sien
 * (`device_workspaces`).
 */
export const serverEntry: FeatureServer<DevicesRepo> = {
    createRepo,
    features: devicesHandlers,
    createService(deps) {
        const sweep = new RetentionSweep(deps);
        return {
            start() {
                sweep.start();
            },
            stop() {
                sweep.stop();
            }
        };
    }
};
