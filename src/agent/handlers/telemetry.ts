import { AGENT_ERROR, AGENT_METRICS_BATCH, AGENT_REPORT, type ProcessKind, type ReportProcess } from 'deveye-types';

import { ack, reply, type AgentSession, type PayloadOf } from './session';

/**
 * Telemetry the agent streams: the OS/security `agent.report` and metric batches.
 * A metric snapshot is one *instant* — graph signals plus the process list that
 * explains them — so there is a single ingestion path and processes are stored
 * under the very timestamp of their metric row. Both persist only once the owner
 * has confirmed the device (status `active`) — the same gate, applied here so an
 * unapproved or revoked agent is acknowledged but never recorded. A persistence
 * failure replies `agent.error`.
 */

/**
 * True (and acks an empty receipt) when the device isn't yet allowed to persist.
 *
 * `s.device` est l'instantané pris à la connexion, et un agent reste connecté
 * des semaines : s'y fier seul faisait qu'un appareil approuvé *pendant* que son
 * agent était en ligne restait à jamais « pending » pour cette session. Tout ce
 * qu'il envoyait était accusé — donc jamais réémis — puis jeté. De l'extérieur :
 * une machine en ligne, sa version d'agent affichée (`agent.hello`, lui, n'est
 * pas filtré), et pas un seul relevé ni rapport. Silencieux des deux côtés.
 *
 * On relit donc le statut avant de refuser, et **seulement** dans ce cas : le
 * chemin normal (déjà `active`) ne coûte rien. Une fois relu actif, l'instantané
 * est corrigé pour de bon, la requête ne se repose plus.
 */
async function gated(s: AgentSession): Promise<boolean> {
    if (s.device.status === 'active') return false;

    const fresh = await s.db.devices.findById(s.device.id);
    if (fresh) s.device = fresh;
    if (s.device.status === 'active') {
        s.logger.info('Device approved while its agent was connected — telemetry resumes');
        return false;
    }

    // Dire pourquoi on jette. Sans cette trace, un appareil jamais approuvé se
    // diagnostique à l'aveugle : rien ne distingue « pas encore autorisé » de
    // « l'agent ne collecte pas ».
    s.logger.warn({ status: s.device.status }, 'Telemetry dropped: device is not active');
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
    if (await gated(s)) return;
    try {
        await s.db.devices.setReport(s.device.id, JSON.stringify(payload.report));
        s.hub.publishReport(s.device.id, payload.report);
        await s.db.devices.touchSeen(s.device.id, Math.floor(Date.now() / 1000));
        // On empile, on n'évalue pas : c'est l'invariant de `SecurityMonitor`.
        // Le moteur relira le rapport depuis `devices.report_json`, qu'on vient
        // justement d'écrire — d'où l'ordre.
        if (s.device.sentinel_enabled === 1) s.sentinel?.enqueueReport(s.device.id);
        ack(s, 1);
    } catch (e) {
        persistFailed(s, e, 'Failed to persist device report');
    }
}

export async function handleMetricsBatch(
    s: AgentSession,
    payload: PayloadOf<typeof AGENT_METRICS_BATCH>
): Promise<void> {
    if (await gated(s)) return;
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
        // Un lot peut porter cent instants (agent revenu après une coupure) :
        // seul le dernier est signalé au moteur, et lui-même n'en garde que le
        // plus récent. Évaluer les cent produirait des constats sur des états
        // qui n'existent plus, au prix fort et sur le chemin le plus chaud.
        if (s.device.sentinel_enabled === 1) {
            const latest = snapshots[snapshots.length - 1];
            if (latest) s.sentinel?.enqueueSnapshot(s.device.id, latest.timestamp);
        }
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
