import { AGENT_ERROR, AGENT_METRICS_BATCH, AGENT_PROCESSES, AGENT_REPORT } from 'deveye-types';

import { ack, reply, type AgentSession, type PayloadOf } from './session';

/**
 * Telemetry the agent streams: the OS/security `agent.report`, process samples and
 * metric batches. All three persist only once the owner has confirmed the device
 * (status `active`) — the same gate, applied here so an unapproved or revoked agent
 * is acknowledged but never recorded. A persistence failure replies `agent.error`.
 */

/** True (and acks an empty receipt) when the device isn't yet allowed to persist. */
function gated(s: AgentSession): boolean {
    if (s.device.status === 'active') return false;
    ack(s, 0);
    return true;
}

function persistFailed(s: AgentSession, e: unknown, what: string): void {
    s.logger.error({ err: (e as Error).message }, what);
    reply(s, { command: AGENT_ERROR, payload: { code: 'internal', message: 'Persist failed' } });
}

export async function handleReport(s: AgentSession, payload: PayloadOf<typeof AGENT_REPORT>): Promise<void> {
    if (gated(s)) return;
    try {
        await s.db.devices.setReport(s.device.id, JSON.stringify(payload.report));
        s.hub.publishReport(s.device.id, payload.report);
        await s.db.devices.touchSeen(s.device.id, Math.floor(Date.now() / 1000));
        ack(s, 1);
    } catch (e) {
        persistFailed(s, e, 'Failed to persist device report');
    }
}

export async function handleProcesses(s: AgentSession, payload: PayloadOf<typeof AGENT_PROCESSES>): Promise<void> {
    if (gated(s)) return;
    try {
        await s.db.processSamples.insertSample(s.device.id, payload.sample);
        ack(s, payload.sample.processes.length);
    } catch (e) {
        persistFailed(s, e, 'Failed to persist process sample');
    }
}

export async function handleMetricsBatch(
    s: AgentSession,
    payload: PayloadOf<typeof AGENT_METRICS_BATCH>
): Promise<void> {
    if (gated(s)) return;
    const { snapshots } = payload;
    try {
        await s.db.metrics.insertBatch(s.device.id, snapshots);
        for (const snapshot of snapshots) s.hub.publishMetric(s.device.id, snapshot);
        await s.db.devices.touchSeen(s.device.id, Math.floor(Date.now() / 1000));
        ack(s, snapshots.length);
    } catch (e) {
        persistFailed(s, e, 'Failed to persist metrics batch');
    }
}
