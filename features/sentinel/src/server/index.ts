import { SENTINEL_AGENT_CONFIG_PROVIDER, type SentinelAgentConfigProvider } from '@deveye/types/sdk';
import type { FeatureServer } from '@deveye/types/sdk/server';

import { SentinelEngine } from './engine';
import { sentinelHandlers } from './handlers';
import { createRepo, type SentinelRepo } from './repo';
import { setEngine } from './_shared';

/**
 * L'entrée serveur du module.
 *
 * `createService` recompose ce que le boot natif faisait : le moteur (file
 * d'ingestion, évaluation par tour, passe lente) démarré, le singleton posé
 * pour les handlers (`sentinel.resetBaseline`), les hooks agent qui
 * remplacent les `enqueue*` que la couche socket de l'app adressait au moteur
 * en dur, et le contrat offert à l'app (`SENTINEL_AGENT_CONFIG_PROVIDER` : la
 * part de Sentinelle dans la config poussée à un agent, sondes éteintes sans
 * ligne).
 *
 * Pas de `migrationsDir` : les tables historiques datent du socle (074, jamais
 * déplacées, allowlist dans deveye-feature.json), et la table de config par
 * appareil (`ft_sentinel_device_config`, au préfixe) a été créée par la 098
 * du socle, parce que ses migrations tournent avant celles des modules et que
 * la copie des colonnes de `devices` devait précéder leur suppression. Le
 * module la possède (son `uninstall.sql` la démonte) ; une nouvelle table
 * inaugurera `src/server/migrations/`. Pas d'entrée `items` : `shareTier:
 * 'never'`, et Sentinelle n'a pas d'éléments.
 */
export const serverEntry: FeatureServer<SentinelRepo> = {
    createRepo,
    features: sentinelHandlers,
    createService(deps) {
        const engine = new SentinelEngine(deps);
        // Ce que l'app recompose dans `agent.config` : l'agent relève ou non la
        // persistance et l'authentification, et à quelle cadence. `null` sans
        // ligne : l'app pousse alors les sondes éteintes, comme pour un module
        // absent.
        const agentConfig: SentinelAgentConfigProvider = {
            configFor: async (deviceId) => {
                const row = await deps.repo.deviceConfig.get(deviceId);
                if (!row) return null;
                return {
                    enabled: row.enabled === 1,
                    integrityMinutes: row.integrity_minutes,
                    authEvents: row.auth_events === 1
                };
            }
        };
        return {
            start() {
                setEngine(engine);
                engine.start();
            },
            stop() {
                engine.stop();
                setEngine(null);
            },
            // Les hooks rendent leur promesse : l'agrégat de l'app journalise un
            // rejet, et un hook qui trébuche ne prive ni les autres modules ni la
            // couche socket. L'app ne les appelle que pour un appareil actif ;
            // c'est le moteur qui relit ses réglages et décide (voir `onReport`).
            agentHooks: {
                onReport: (deviceId) => engine.onReport(deviceId),
                onMetricsBatch: (deviceId, snapshots) => engine.onMetricsBatch(deviceId, snapshots),
                onIntegrity: (deviceId, integrity) => engine.onIntegrity(deviceId, integrity),
                onAuthEvents: (deviceId, auth) => engine.onAuthEvents(deviceId, auth)
            },
            providers: { [SENTINEL_AGENT_CONFIG_PROVIDER]: agentConfig }
        };
    }
};
