import { AGENT_ERROR, AGENT_METRICS_BATCH, AGENT_REPORT, type ProcessKind, type ReportProcess } from '@deveye/types';

import { isPlanPaused } from '@/Services/planPauses';
import { ack, reply, type AgentSession, type PayloadOf } from './session';

/**
 * Telemetry the agent streams: the OS/security `agent.report` and metric batches.
 * A metric snapshot is one *instant* (graph signals plus the process list that
 * explains them), so there is a single ingestion path and processes are stored
 * under the very timestamp of their metric row. A persistence failure replies
 * `agent.error`.
 */

/**
 * Vrai (et accuse un reçu vide) quand rien ne doit être enregistré. La socket
 * n'admet que `active`, et `pending_deletion` le temps de l'ordre
 * d'auto-destruction, qui ne persiste rien. La mise en pause coupe la socket :
 * ceci couvre la trame en vol.
 */
export function gated(s: AgentSession): boolean {
    if (s.device.status === 'active' && !isPlanPaused('devices.agents', s.device.id)) return false;
    ack(s, 0);
    return true;
}

/**
 * Floor between two *persisted* process samples of one device. Defense in depth
 * against a misbehaving or looping agent (each instant can carry up to 2000
 * process entries, so an uncapped stream balloons the DB). Kept below the
 * smallest configurable cadence (5 s) so legitimate samples — including a manual
 * refresh — are never affected. Tripping it only skips the process blob: the
 * metric row itself is always written, so the graphs stay continuous.
 */
const MIN_PROCESS_SAMPLE_GAP_MS = 4_000;

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
        // Les modules reçoivent le rapport après sa persistance : ils le relisent
        // par la façade des appareils. Ils empilent, ils n'évaluent pas.
        s.hooks.onReport(s.device.id, payload.report);
        ack(s, 1);
    } catch (e) {
        persistFailed(s, e, 'Failed to persist device report');
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
        for (const snapshot of snapshots) {
            if (snapshot.processes !== null) {
                await persistProcesses(s, snapshot.timestamp, snapshot.processKind ?? 'all', snapshot.processes);
            }
            s.hub.publishMetric(s.device.id, snapshot);
        }
        await s.db.devices.touchSeen(s.device.id, Math.floor(Date.now() / 1000));
        // Le lot entier, du plus ancien au plus récent : les modules empilent
        // sans évaluer, hors du chemin le plus chaud.
        s.hooks.onMetricsBatch(s.device.id, snapshots);
        ack(s, snapshots.length);
    } catch (e) {
        persistFailed(s, e, 'Failed to persist metrics batch');
    }
}

/**
 * Store one instant's process list next to its metric row (same `ts`). Throttled
 * per device, and non-fatal: a failed blob must not cost the whole batch its
 * metric rows, which are already written by the time we get here.
 */
async function persistProcesses(
    s: AgentSession,
    ts: number,
    kind: ProcessKind,
    processes: ReportProcess[]
): Promise<void> {
    const last = lastProcessSampleTs.get(s.device.id);
    if (last !== undefined && ts - last < MIN_PROCESS_SAMPLE_GAP_MS) {
        s.logger.warn({ lastTs: last, ts }, 'Process sample throttled (too soon after previous)');
        return;
    }
    try {
        await s.db.processSamples.insertSample(s.device.id, ts, kind, processes);
        lastProcessSampleTs.set(s.device.id, ts);
    } catch (e) {
        s.logger.error({ err: (e as Error).message, ts }, 'Failed to persist process sample');
    }
}
