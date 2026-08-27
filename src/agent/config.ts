import {
    DEFAULT_METRIC_INTERVAL_SECONDS,
    DEFAULT_PROCESS_CAPTURE,
    type AgentConfigPayload,
    type DeviceRow,
    type ProcessCapture
} from '@deveye/types';
import {
    DEFAULT_SENTINEL_INTEGRITY_MINUTES,
    SENTINEL_AGENT_CONFIG_PROVIDER,
    type SentinelAgentConfigProvider
} from '@deveye/types/sdk';

import { moduleProvider } from '@/features/_sdk/register';

/**
 * La config de collecte que le serveur pousse à un agent (`agent.config`), à
 * la connexion et à chaque changement.
 *
 * Recomposée de deux sources : la ligne appareil (cadence des métriques,
 * capture des processus, ce que règle la feature Appareils) et ce que les
 * modules installés y contribuent. Sentinelle est le premier : depuis son
 * rapatriement, ses réglages par appareil ne vivent plus dans `devices` mais
 * dans sa table, et l'app les lui demande par le provider publié
 * (`SENTINEL_AGENT_CONFIG_PROVIDER`). Sans module installé, ou sans ligne pour
 * cet appareil, les sondes sont éteintes et la cadence est celle par défaut :
 * une machine que personne ne surveille ne doit pas voir ses journaux lus.
 *
 * Importe `_sdk/register` (et non l'inverse) : c'est le sens de la
 * dépendance, l'app compose, le module contribue.
 */
export async function agentConfigFor(row: DeviceRow): Promise<AgentConfigPayload> {
    const metricSeconds = row.metric_interval_seconds ?? DEFAULT_METRIC_INTERVAL_SECONDS;
    const capture = (row.process_capture as ProcessCapture | null) ?? DEFAULT_PROCESS_CAPTURE;
    const sentinel = await moduleProvider<SentinelAgentConfigProvider>(SENTINEL_AGENT_CONFIG_PROVIDER)?.configFor(
        row.id
    );
    return {
        metricIntervalMs: metricSeconds * 1000,
        processCapture: capture,
        // Sentinelle éteinte, l'agent ne relève ni persistance ni
        // authentification. Ces deux sondes ne coûtent rien à qui ne les demande
        // pas, et une machine non surveillée ne doit pas voir ses journaux lus.
        sentinelEnabled: sentinel?.enabled ?? false,
        integrityIntervalMs: (sentinel?.integrityMinutes ?? DEFAULT_SENTINEL_INTEGRITY_MINUTES) * 60_000,
        authEventsEnabled: sentinel?.authEvents ?? false
    };
}
