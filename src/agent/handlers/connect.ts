import { AGENT_HELLO, isNewerVersion } from 'deveye-types';

import { appVersion } from '@/version';
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
    // An agent older than the server may not understand the frames we push: the
    // protocol only ever moves forward (no compatibility shims), so a stale agent
    // silently drops what it can't parse — `agent.config` included, which leaves it
    // collecting on its own bootstrap cadence forever. Say so once per connection;
    // this is the trace that was missing while a whole fleet ignored its settings.
    const server = appVersion();
    if (isNewerVersion(server, payload.agentVersion)) {
        s.logger.warn(
            { agentVersion: payload.agentVersion, serverVersion: server },
            'Agent older than the server — pushed config may be ignored; update this agent'
        );
    }
    ack(s, 0);
}
