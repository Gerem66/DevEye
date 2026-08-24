import { AGENT_TERM_EXIT, AGENT_TERM_OUTPUT } from '@deveye/types';

import { ack, type AgentSession, type PayloadOf } from './session';

/**
 * Terminal session streams from the agent (`term.output`, `term.exit`). Pure live
 * relay — nothing is persisted; we just fan each frame out to the device's
 * subscribers, which the client filters by session id.
 */

/** `term.output` — a chunk of PTY output (base64) for one session. */
export async function handleTermOutput(s: AgentSession, payload: PayloadOf<typeof AGENT_TERM_OUTPUT>): Promise<void> {
    s.hub.publishTermOutput({ deviceId: s.device.id, sessionId: payload.sessionId, data: payload.data });
    ack(s, 1);
}

/** `term.exit` — a session ended (shell exited, killed, or open failed). */
export async function handleTermExit(s: AgentSession, payload: PayloadOf<typeof AGENT_TERM_EXIT>): Promise<void> {
    s.hub.publishTermExit({
        deviceId: s.device.id,
        sessionId: payload.sessionId,
        code: payload.code,
        error: payload.error
    });
    ack(s, 1);
}
