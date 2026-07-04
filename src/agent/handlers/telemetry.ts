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

/**
 * Floor between two *persisted* process samples of one device. Defense in depth
 * against a misbehaving or looping agent (each snapshot can carry up to 2000
 * process rows, so an uncapped stream balloons the DB and drowns the timeline
 * in marks). Well under the smallest configurable snapshot cadence (60 s), so
 * legitimate samples — including a manual refresh — are never affected.
 */
const MIN_PROCESS_SAMPLE_GAP_MS = 30_000;

/** Last persisted process-sample `ts` per device (process-local; reset on boot). */
const lastProcessSampleTs = new Map<string, number>();

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
    const last = lastProcessSampleTs.get(s.device.id);
    if (last !== undefined && payload.sample.ts - last < MIN_PROCESS_SAMPLE_GAP_MS) {
        s.logger.warn({ lastTs: last, ts: payload.sample.ts }, 'Process sample throttled (too soon after previous)');
        ack(s, 0);
        return;
    }
    try {
        await s.db.processSamples.insertSample(s.device.id, payload.sample);
        lastProcessSampleTs.set(s.device.id, payload.sample.ts);
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
