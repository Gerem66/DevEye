import type { FeatureServer } from '@deveye/types/sdk/server';

import { devicesHandlers } from './handlers';
import { createRepo, type DevicesRepo } from './repo';
import { RetentionSweep } from './service';

/**
 * L'entrée serveur du module.
 *
 * `createService` recompose ce que le boot natif faisait dans `index.ts` de
 * l'app : le balayage horaire de rétention (`RetentionSweep`), sur le dépôt
 * du module et la variable `MONITORING_RETENTION_DAYS` lue par `env.ts`.
 * Aucun hook agent : la télémétrie est ingérée par l'app, hors session, et
 * le module la relit en base ; aucun provider : rien ici que l'app ait à
 * lire d'un module. Appareils ne notifie personne (`notifies: false`).
 *
 * Pas de `migrationsDir` : les six tables datent du socle et sont partagées
 * avec l'infrastructure (voir `repo/index.ts` et l'allowlist de
 * `deveye-feature.json`) ; une table propre au module inaugurera
 * `src/server/migrations/` avec le préfixe `ft_devices_`. Pas d'entrée
 * `items` : `shareTier: 'never'`, et le partage d'un appareil entre espaces
 * est le sien (`device_workspaces`, `devices.setWorkspaces`), pas celui des
 * projections de l'app.
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
