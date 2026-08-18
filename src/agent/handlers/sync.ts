import {
    AGENT_SYNC_ACK,
    AGENT_SYNC_CHANGED,
    AGENT_SYNC_CHUNK,
    AGENT_SYNC_INDEX,
    AGENT_SYNC_OP_RESULT
} from 'deveye-types';

import { ack, type AgentSession, type PayloadOf } from './session';

/**
 * Frames CloudSync de l'agent. Aucune logique ici : tout est routé vers le
 * moteur, qui corrèle par `sessionId`/`opId` vers la session propriétaire
 * (les frames orphelines — session terminée, opId inconnu — sont ignorées).
 * L'appareil émetteur est TOUJOURS `s.device.id` (authentifié), jamais le
 * champ du payload.
 */

export async function handleSyncChanged(s: AgentSession, payload: PayloadOf<typeof AGENT_SYNC_CHANGED>): Promise<void> {
    s.cloudSync.onSyncChanged(s.device.id, payload.shareId);
    ack(s, 1);
}

export async function handleSyncIndex(s: AgentSession, payload: PayloadOf<typeof AGENT_SYNC_INDEX>): Promise<void> {
    s.cloudSync.routeEvent(s.device.id, payload.sessionId, {
        type: 'index',
        entries: payload.entries,
        done: payload.done,
        scanned: payload.scanned,
        fingerprint: payload.fingerprint,
        error: payload.error
    });
    ack(s, payload.entries.length);
}

export async function handleSyncChunk(s: AgentSession, payload: PayloadOf<typeof AGENT_SYNC_CHUNK>): Promise<void> {
    s.cloudSync.routeEvent(s.device.id, payload.opId, {
        type: 'chunk',
        data: payload.data,
        done: payload.done,
        hash: payload.hash,
        size: payload.size,
        mtime: payload.mtime,
        error: payload.error
    });
    ack(s, 1);
}

export async function handleSyncAck(s: AgentSession, payload: PayloadOf<typeof AGENT_SYNC_ACK>): Promise<void> {
    s.cloudSync.routeEvent(s.device.id, payload.opId, { type: 'ack', seq: payload.seq });
}

export async function handleSyncOpResult(
    s: AgentSession,
    payload: PayloadOf<typeof AGENT_SYNC_OP_RESULT>
): Promise<void> {
    s.cloudSync.routeEvent(s.device.id, payload.opId, {
        type: 'opResult',
        op: payload.op,
        ok: payload.ok,
        resumeFrom: payload.resumeFrom,
        error: payload.error
    });
    ack(s, 1);
}
