import { AGENT_HELLO } from 'deveye-types';

import { ack, type AgentSession, type PayloadOf } from './session';

/**
 * `agent.hello` — the first frame an agent sends. Remember which agent build +
 * target is running so the UI can flag stale agents and the server can resolve the
 * right signed binary for a self-update.
 */
export async function handleHello(s: AgentSession, payload: PayloadOf<typeof AGENT_HELLO>): Promise<void> {
    try {
        await s.db.devices.setAgentVersion(s.device.id, payload.agentVersion);
        if (payload.target) await s.db.devices.setAgentTarget(s.device.id, payload.target);
    } catch (e) {
        s.logger.warn({ err: (e as Error).message }, 'Failed to persist agent version/target');
    }
    ack(s, 0);
}
