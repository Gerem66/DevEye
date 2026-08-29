import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SENTINEL_AGENT_CONFIG_PROVIDER, type SentinelAgentConfigProvider } from '@deveye/types/sdk';
import type { FeatureServer } from '@deveye/types/sdk/server';

import { SentinelEngine } from './engine';
import { sentinelHandlers } from './handlers';
import { createRepo, type SentinelRepo } from './repo';
import { setEngine } from './_shared';

/**
 * `createService` monte le moteur (file d'ingestion, évaluation par tour, passe
 * lente), le pose pour les handlers, branche les hooks agent qui l'alimentent
 * et offre le contrat `SENTINEL_AGENT_CONFIG_PROVIDER` : la part de Sentinelle
 * dans la config poussée à un agent.
 *
 * `migrationsDir` : les tables datent du socle, la séquence du module ne porte
 * que ce qui les corrige. Pas d'entrée `items` : `shareTier: 'never'`,
 * Sentinelle n'a pas d'éléments.
 */
export const serverEntry: FeatureServer<SentinelRepo> = {
    createRepo,
    features: sentinelHandlers,
    migrationsDir: path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations'),
    createService(deps) {
        const engine = new SentinelEngine(deps);
        // Ce que l'app recompose dans `agent.config` : les sondes que l'agent relève
        // et à quelle cadence. `null` sans ligne, l'app pousse alors les sondes
        // éteintes, comme pour un module absent.
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
            // Les hooks rendent leur promesse : l'app journalise un rejet, et un hook
            // qui trébuche ne prive ni les autres modules ni la couche socket. L'app
            // ne les appelle que pour un appareil actif, le moteur relit ses réglages
            // et décide.
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
