import { DEFAULT_PROCESS_CAPTURE, type AgentConfigPayload, type DeviceRow, type ProcessCapture } from '@deveye/types';
import {
    DEFAULT_SENTINEL_INTEGRITY_MINUTES,
    SENTINEL_AGENT_CONFIG_PROVIDER,
    type SentinelAgentConfigProvider
} from '@deveye/types/sdk';

import type { Database } from '@/db';
import { moduleProvider } from '@/features/_sdk/register';

import { metricIntervalOf } from './cadence';

/**
 * La config de collecte poussée à un agent (`agent.config`), à la connexion et
 * à chaque changement : la ligne appareil (cadence, capture des processus) plus
 * ce que les modules installés contribuent (Sentinelle, par son provider). Une
 * cadence laissée au défaut suit l'offre du propriétaire de l'espace.
 *
 * Importe `_sdk/register` et non l'inverse : l'app compose, le module contribue.
 */
export async function agentConfigFor(db: Pick<Database, 'workspaces'>, row: DeviceRow): Promise<AgentConfigPayload> {
    const metricSeconds = await metricIntervalOf(db, row);
    const capture = (row.process_capture as ProcessCapture | null) ?? DEFAULT_PROCESS_CAPTURE;
    const sentinel = await moduleProvider<SentinelAgentConfigProvider>(SENTINEL_AGENT_CONFIG_PROVIDER)?.configFor(
        row.id
    );
    return {
        metricIntervalMs: metricSeconds * 1000,
        processCapture: capture,
        // Sans Sentinelle, l'agent ne relève ni persistance ni authentification :
        // une machine non surveillée ne doit pas voir ses journaux lus.
        sentinelEnabled: sentinel?.enabled ?? false,
        integrityIntervalMs: (sentinel?.integrityMinutes ?? DEFAULT_SENTINEL_INTEGRITY_MINUTES) * 60_000,
        authEventsEnabled: sentinel?.authEvents ?? false
    };
}
