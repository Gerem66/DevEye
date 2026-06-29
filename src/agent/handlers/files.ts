import {
    AGENT_FILES_CHUNK,
    AGENT_FILES_LISTING,
    AGENT_FILES_MATCHES,
    AGENT_FILES_OP_RESULT,
    AGENT_FILES_USAGE
} from 'deveye-types';

import { ack, type AgentSession, type PayloadOf } from './session';

/**
 * File-explorer replies from the agent (`files.listing`, `files.usage`,
 * `files.matches`, `files.opResult`). Pure live relay keyed by `opId` — nothing is
 * persisted; we just fan each result out to the device's subscribers.
 */

export async function handleFilesListing(
    s: AgentSession,
    payload: PayloadOf<typeof AGENT_FILES_LISTING>
): Promise<void> {
    s.hub.publishFilesListing({
        deviceId: s.device.id,
        opId: payload.opId,
        listing: payload.listing,
        error: payload.error
    });
    ack(s, 1);
}

export async function handleFilesUsage(s: AgentSession, payload: PayloadOf<typeof AGENT_FILES_USAGE>): Promise<void> {
    s.hub.publishFilesUsage({
        deviceId: s.device.id,
        opId: payload.opId,
        entries: payload.entries,
        error: payload.error
    });
    ack(s, payload.entries.length);
}

export async function handleFilesMatches(
    s: AgentSession,
    payload: PayloadOf<typeof AGENT_FILES_MATCHES>
): Promise<void> {
    s.hub.publishFilesMatches({
        deviceId: s.device.id,
        opId: payload.opId,
        matches: payload.matches,
        truncated: payload.truncated,
        error: payload.error
    });
    ack(s, payload.matches.length);
}

export async function handleFilesOpResult(
    s: AgentSession,
    payload: PayloadOf<typeof AGENT_FILES_OP_RESULT>
): Promise<void> {
    s.hub.publishFilesOp({
        deviceId: s.device.id,
        opId: payload.opId,
        op: payload.op,
        ok: payload.ok,
        error: payload.error
    });
    ack(s, 1);
}

/** `files.chunk` — one chunk of a downloaded file (last carries `done`). */
export async function handleFilesChunk(s: AgentSession, payload: PayloadOf<typeof AGENT_FILES_CHUNK>): Promise<void> {
    s.hub.publishFilesChunk({
        deviceId: s.device.id,
        opId: payload.opId,
        data: payload.data,
        done: payload.done,
        error: payload.error
    });
    ack(s, 1);
}
