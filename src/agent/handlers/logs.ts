import { AGENT_LOG_LINES, AGENT_LOG_SOURCES_RESULT } from 'deveye-types';

import { ack, type AgentSession, type PayloadOf } from './session';

/**
 * Replies to the relayed device-log commands (`log.sources`, `log.query`). These
 * carry no persisted state — the agent reads the logs live and we just fan the
 * results out to the device's subscribers, exactly like the package events.
 */

/** `log.sourcesResult` — the log sources the agent discovered. */
export async function handleLogSourcesResult(
    s: AgentSession,
    payload: PayloadOf<typeof AGENT_LOG_SOURCES_RESULT>
): Promise<void> {
    s.hub.publishLogSources({ deviceId: s.device.id, sources: payload.sources });
    ack(s, payload.sources.length);
}

/** `log.lines` — one chunk of queried log lines (last one carries `done: true`). */
export async function handleLogLines(s: AgentSession, payload: PayloadOf<typeof AGENT_LOG_LINES>): Promise<void> {
    s.hub.publishLogLines({
        deviceId: s.device.id,
        queryId: payload.queryId,
        lines: payload.lines,
        done: payload.done,
        error: payload.error
    });
    ack(s, payload.lines.length);
}
