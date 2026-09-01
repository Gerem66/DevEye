import {
    AGENT_DOCKER_DONE,
    AGENT_DOCKER_INVENTORY_RESULT,
    AGENT_DOCKER_PROGRESS,
    AGENT_DOCKER_STATS_RESULT
} from '@deveye/types';

import { ack, type AgentSession, type PayloadOf } from './session';

/**
 * Replies to the relayed container commands (`docker.inventory`, `docker.stats`,
 * `docker.action`). Rien n'est persisté : l'agent interroge le moteur en direct
 * et on relaie aux abonnés de l'appareil, exactement comme les journaux.
 */

/** `docker.inventoryResult` — containers, images, volumes and networks. */
export async function handleDockerInventoryResult(
    s: AgentSession,
    payload: PayloadOf<typeof AGENT_DOCKER_INVENTORY_RESULT>
): Promise<void> {
    s.hub.publishDockerInventory({
        deviceId: s.device.id,
        inventory: payload.inventory,
        // L'agent ignore ce que le serveur a accepté : c'est ici qu'on ajoute
        // l'action déjà en cours, pour qu'un second écran ne la relance pas.
        running: s.hub.runningDockerOp(s.device.id)
    });
    ack(s, payload.inventory.containers.length);
}

/** `docker.statsResult` — one resource sample per running container. */
export async function handleDockerStatsResult(
    s: AgentSession,
    payload: PayloadOf<typeof AGENT_DOCKER_STATS_RESULT>
): Promise<void> {
    s.hub.publishDockerStats({ deviceId: s.device.id, stats: payload.stats });
    ack(s, payload.stats.length);
}

/** `docker.progress` — one output line of a running action. */
export async function handleDockerProgress(
    s: AgentSession,
    payload: PayloadOf<typeof AGENT_DOCKER_PROGRESS>
): Promise<void> {
    s.hub.publishDockerProgress({ deviceId: s.device.id, opId: payload.opId, line: payload.line });
    ack(s, 1);
}

/** `docker.done` — an action's outcome; `publishDockerDone` releases its lock. */
export async function handleDockerDone(s: AgentSession, payload: PayloadOf<typeof AGENT_DOCKER_DONE>): Promise<void> {
    s.hub.publishDockerDone({
        deviceId: s.device.id,
        opId: payload.opId,
        action: payload.action,
        ok: payload.ok,
        error: payload.error
    });
    ack(s, 1);
}
