import {
    AGENT_SYNC_ACK,
    AGENT_SYNC_BUSY,
    AGENT_SYNC_CHANGED,
    AGENT_SYNC_CHUNK,
    AGENT_SYNC_DEVICE_KEY,
    AGENT_SYNC_INDEX,
    AGENT_SYNC_OP_RESULT
} from '@deveye/types';

import { ack, type AgentSession, type PayloadOf } from './session';

/**
 * Frames de synchronisation de l'agent. Aucune logique ici : tout est routé
 * vers les hooks des modules installés (CloudSync), qui corrèlent par
 * `sessionId`/`opId` vers la session propriétaire ; sans module, l'agrégat est
 * un no-op et la frame est simplement acquittée. L'appareil émetteur est
 * TOUJOURS `s.device.id` (authentifié), jamais le champ du payload.
 */

export async function handleSyncChanged(s: AgentSession, payload: PayloadOf<typeof AGENT_SYNC_CHANGED>): Promise<void> {
    s.hooks.onSyncChanged(s.device.id, payload);
    ack(s, 1);
}

export async function handleSyncIndex(s: AgentSession, payload: PayloadOf<typeof AGENT_SYNC_INDEX>): Promise<void> {
    s.hooks.onSyncIndex(s.device.id, payload);
    ack(s, payload.entries.length);
}

export async function handleSyncChunk(s: AgentSession, payload: PayloadOf<typeof AGENT_SYNC_CHUNK>): Promise<void> {
    s.hooks.onSyncChunk(s.device.id, payload);
    ack(s, 1);
}

export async function handleSyncAck(s: AgentSession, payload: PayloadOf<typeof AGENT_SYNC_ACK>): Promise<void> {
    s.hooks.onSyncAck(s.device.id, payload);
}

/** Pas d'AGENT_ACK : un battement n'appelle pas de réponse, comme `sync.ack`. */
export async function handleSyncBusy(s: AgentSession, payload: PayloadOf<typeof AGENT_SYNC_BUSY>): Promise<void> {
    s.hooks.onSyncBusy(s.device.id, payload);
}

export async function handleSyncOpResult(
    s: AgentSession,
    payload: PayloadOf<typeof AGENT_SYNC_OP_RESULT>
): Promise<void> {
    s.hooks.onSyncOpResult(s.device.id, payload);
    ack(s, 1);
}

export async function handleSyncDeviceKey(
    s: AgentSession,
    payload: PayloadOf<typeof AGENT_SYNC_DEVICE_KEY>
): Promise<void> {
    s.hooks.onSyncDeviceKey(s.device.id, payload);
    ack(s, 1);
}
