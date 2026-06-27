import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ws } from '@/api/ws';
import { useDevices } from '@/stores/devices';
import { acquireMetrics } from '@/stores/metricsSubscription';
import { openInfo } from '@/Components/InfoPopup';
import { Dialog } from '@/Components/Dialog';
import Button from '@/Components/Button';
import {
    DEVICE_PRESENCE_EVENT,
    DEVICE_REPORT_EVENT,
    METRICS_PUSH_EVENT,
    type DevicePresence,
    type DeviceReport,
    type DeviceReportPush,
    type MetricSnapshot,
    type MetricsPush,
    type MetricsResolution,
    type PresenceEvent,
    type ProcessSample
} from 'deveye-types';
import { HardwareInfo } from './HardwareInfo';
import { Connections } from './Connections';
import { PrivilegeInfo } from './PrivilegeInfo';
import { OpenPorts } from './OpenPorts';
import { ConfigDialog } from './ConfigDialog';
import { GraphDetail, type DetailRow } from './GraphDetail';
import { Timeline } from './Timeline';
import { MiniGraph, type Series } from './MiniGraph';
import { PackagesPanel } from './PackagesPanel';
import { useAgentUpdate } from './useAgentUpdate';
import { agentUpdatable } from '../agentVersion';
import {
    ACTIVITY_META,
    activityLevel,
    formatAgo,
    formatBytes,
    formatBytesFr,
    formatDuration,
    formatRate,
    formatUptime,
    pct
} from './utils';
import styles from './Monitoring.module.css';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_SNAPSHOT_INTERVAL_S = 300;
/** Graphs shown before "Afficher plus" (≈ 2 rows at 3 columns on a wide panel). */
const COLLAPSED_GRAPHS = 6;

/** Discreet timeline zoom presets (visible window span ending at "now"/day end). */
const ZOOM_PRESETS: { label: string; ms: number }[] = [
    { label: '30 min', ms: 30 * 60 * 1000 },
    { label: '1 h', ms: 60 * 60 * 1000 },
    { label: '3 h', ms: 3 * 60 * 60 * 1000 },
    { label: '6 h', ms: 6 * 60 * 60 * 1000 },
    { label: '12 h', ms: 12 * 60 * 60 * 1000 },
    { label: 'Jour', ms: DAY_MS }
];

/**
 * What the panel is currently showing:
 * - `live`: the timeline window (rolling 24h or a chosen day), latest values;
 * - `range`: a dragged zone — graphs over it, KPIs averaged, processes at its end;
 * - `snapshot`: a single instant — exact KPIs/processes, graphs over the snapshot
 *   interval around it (fine resolution).
 */
type Focus = { kind: 'live' } | { kind: 'range'; start: number; end: number } | { kind: 'snapshot'; at: number };

/** Bucketing resolution to keep the query light at wide zoom levels. */
function spanResolution(spanMs: number): MetricsResolution {
    if (spanMs <= 60 * 60 * 1000) return 'raw';
    if (spanMs <= 12 * 60 * 60 * 1000) return 'minute';
    return 'hour';
}

/** Keep last-known values for fields the light metric cycle leaves null. */
const SPARSE_FIELDS: (keyof MetricSnapshot)[] = [
    'processCount',
    'diskReadBytes',
    'diskWriteBytes',
    'activeConnections',
    'gpuPercent',
    'cpuTempC',
    'loadAvg1'
];
function mergeSnapshot(prev: MetricSnapshot | null, next: MetricSnapshot): MetricSnapshot {
    if (!prev) return next;
    const out = { ...next };
    for (const k of SPARSE_FIELDS) {
        if (out[k] == null && prev[k] != null) (out[k] as number | null) = prev[k] as number | null;
    }
    return out;
}

/** The point closest to `at` within a series. */
function nearestPoint(points: MetricSnapshot[], at: number): MetricSnapshot | null {
    let best: MetricSnapshot | null = null;
    let bestDist = Infinity;
    for (const p of points) {
        const d = Math.abs(p.timestamp - at);
        if (d < bestDist) {
            bestDist = d;
            best = p;
        }
    }
    return best;
}

/** A synthetic snapshot whose gauges/counters are averaged over `points`. */
function averageSnapshot(points: MetricSnapshot[]): MetricSnapshot | null {
    if (points.length === 0) return null;
    const last = points[points.length - 1];
    const avg = (sel: (p: MetricSnapshot) => number | null): number | null => {
        let sum = 0;
        let n = 0;
        for (const p of points) {
            const v = sel(p);
            if (v != null && !Number.isNaN(v)) {
                sum += v;
                n++;
            }
        }
        return n > 0 ? sum / n : null;
    };
    const avgRound = (sel: (p: MetricSnapshot) => number | null): number | null => {
        const v = avg(sel);
        return v == null ? null : Math.round(v);
    };
    return {
        ...last,
        cpuPercent: avg((p) => p.cpuPercent) ?? last.cpuPercent,
        memUsedBytes: Math.round(avg((p) => p.memUsedBytes) ?? last.memUsedBytes),
        usersCount: avgRound((p) => p.usersCount) ?? last.usersCount,
        loadAvg1: avg((p) => p.loadAvg1),
        processCount: avgRound((p) => p.processCount),
        activeConnections: avgRound((p) => p.activeConnections)
    };
}

function InfoCard({
    label,
    value,
    muted,
    hint,
    onClick
}: {
    label: string;
    value: string;
    muted?: boolean;
    hint?: string;
    /** When set, the card becomes a button (e.g. to open a detail popup). */
    onClick?: () => void;
}) {
    const className = `${styles.infoCard} ${muted ? styles.muted : ''} ${onClick ? styles.infoCardBtn : ''}`;
    const inner = (
        <>
            <span className={styles.infoLabel}>
                {label}
                {onClick && <span className={`icon icon-details ${styles.infoCardIcon}`} />}
            </span>
            <span className={styles.infoVal}>{value}</span>
        </>
    );
    return onClick ? (
        <button type='button' className={className} title={hint} onClick={onClick}>
            {inner}
        </button>
    ) : (
        <div className={className} title={hint}>
            {inner}
        </div>
    );
}

function SecurityChip({ label, value }: { label: string; value: boolean | null }) {
    let tone = styles.secUnknown;
    let text = 'Inconnu';
    if (value !== null) {
        tone = value ? styles.secGood : styles.secBad;
        text = value ? 'Oui' : 'Non';
    }
    return (
        <div className={`${styles.secChip} ${tone}`}>
            <span className={styles.secLabel}>{label}</span>
            <span className={styles.secVal}>{text}</span>
        </div>
    );
}

/** {current, avg, min, max} of a value series (skips null/NaN). */
function stats(points: { t: number; v: number }[]): { cur: number; avg: number; min: number; max: number } | null {
    if (points.length === 0) return null;
    let sum = 0;
    let max = -Infinity;
    let min = Infinity;
    for (const p of points) {
        sum += p.v;
        if (p.v > max) max = p.v;
        if (p.v < min) min = p.v;
    }
    return { cur: points[points.length - 1].v, avg: sum / points.length, min, max };
}

export interface MonitoringPanelProps {
    /** Device whose metrics this panel shows. */
    deviceId: string;
}

/**
 * Per-device monitoring panel: live activity, timeline, graphs, KPIs, security,
 * ports and processes for a single machine. Reused by the full Monitoring view
 * (alongside its device sidebar) and by the home device tile's popup (standalone,
 * no sidebar). Owns the device's live state (presence/report/metric pushes) and
 * its metric subscription, scoped to `deviceId`.
 */
export default function MonitoringPanel({ deviceId }: MonitoringPanelProps) {
    const { devices: baseDevices, loading, refresh } = useDevices();
    const [override, setOverride] = useState<{ online?: boolean; report?: DeviceReport | null }>({});
    const [configOpen, setConfigOpen] = useState(false);
    const [packagesOpen, setPackagesOpen] = useState(false);
    const updater = useAgentUpdate();
    // Storage footprint of the device's stored snapshots.
    const [storage, setStorage] = useState<{ snapshots: number; rows: number; bytes: number } | null>(null);
    // Snapshot-deletion confirmation (targets the current snapshot/zone focus).
    const [deleteOpen, setDeleteOpen] = useState(false);
    const [deleting, setDeleting] = useState(false);
    // Pin (permanent keep) in flight for the current snapshot/zone focus.
    const [pinning, setPinning] = useState(false);

    // Timeline window: dayStart null = live (rolling last 24h); otherwise a day.
    const [dayStart, setDayStart] = useState<number | null>(null);
    // Visible window span (zoom). Ends at "now" (live) or the day's end.
    const [spanMs, setSpanMs] = useState<number>(DAY_MS);
    const [windowRange, setWindowRange] = useState<{ start: number; end: number }>({
        start: Date.now() - DAY_MS,
        end: Date.now()
    });
    const [focus, setFocus] = useState<Focus>({ kind: 'live' });

    const [presence, setPresence] = useState<{ onlineAtStart: boolean; events: PresenceEvent[] }>({
        onlineAtStart: false,
        events: []
    });
    const [snapshotTimes, setSnapshotTimes] = useState<number[]>([]);
    const [pinnedTimes, setPinnedTimes] = useState<number[]>([]);
    const [points, setPoints] = useState<MetricSnapshot[]>([]);
    const [procSample, setProcSample] = useState<ProcessSample | null>(null);
    const [showAllProcs, setShowAllProcs] = useState(false);
    const [report, setReport] = useState<DeviceReport | null>(null);
    const [liveSnapshot, setLiveSnapshot] = useState<MetricSnapshot | null>(null);
    const [refreshing, setRefreshing] = useState(false);
    const [dataDays, setDataDays] = useState<string[]>([]);
    const [graphsExpanded, setGraphsExpanded] = useState(false);
    // False from the moment the device changes until its first metrics query
    // resolves. The graphs and activity hero come *only* from that historical
    // query, so we show loaders for them until it lands — everything else (KPIs,
    // security, online state) is seeded instantly by the subscribe push.
    const [metricsReady, setMetricsReady] = useState(false);

    const baseDevice = baseDevices.find((d) => d.id === deviceId) ?? null;
    const selected = baseDevice ? { ...baseDevice, ...override } : null;
    const idRef = useRef<string>(deviceId);
    idRef.current = deviceId;

    const snapshotIntervalMs = (selected?.snapshotIntervalSeconds ?? DEFAULT_SNAPSHOT_INTERVAL_S) * 1000;

    // The most recent process measurement in the loaded series: its count and when
    // it was taken. `processCount` is captured only in the heavy (~5-min) snapshot,
    // never in the light metric cycle, so this is the authoritative "last known".
    // Used both for the always-visible Processus KPI and to align the process-list
    // fetch (`processAt`) with the same snapshot — so the count and the list match.
    const lastProc = useMemo<{ count: number; at: number } | null>(() => {
        for (let i = points.length - 1; i >= 0; i--) {
            const c = points[i].processCount;
            if (c != null) return { count: c, at: points[i].timestamp };
        }
        return null;
    }, [points]);

    // The time window the graphs cover, derived from the focus.
    const graphWindow = useMemo(() => {
        if (focus.kind === 'range') return { start: focus.start, end: focus.end };
        if (focus.kind === 'snapshot') return { start: Math.max(0, focus.at - snapshotIntervalMs), end: focus.at };
        return windowRange;
    }, [focus, windowRange, snapshotIntervalMs]);
    const resolution = spanResolution(graphWindow.end - graphWindow.start);
    // In live focus, track the last full snapshot's timestamp so the process list
    // re-fetches when a new snapshot lands and stays in lockstep with the KPI count.
    const processAt =
        focus.kind === 'snapshot' ? focus.at : focus.kind === 'range' ? focus.end : (lastProc?.at ?? windowRange.end);

    // Changing device: drop the previous machine's transient data so its graphs,
    // activity and KPIs never bleed into the new selection. The per-device effects
    // below refill everything; until the first metrics query resolves we show
    // loaders instead of stale or empty cards.
    useEffect(() => {
        setMetricsReady(false);
        setOverride({});
        setPoints([]);
        setLiveSnapshot(null);
        setProcSample(null);
        setSnapshotTimes([]);
        setPinnedTimes([]);
        setStorage(null);
        setPresence({ onlineAtStart: false, events: [] });
    }, [deviceId]);

    // Which days have data (for the calendar + day arrows).
    useEffect(() => {
        const id = deviceId;
        ws.send('metrics.availability', { deviceId: id, tzOffsetMinutes: new Date().getTimezoneOffset() })
            .then((res) => {
                if (idRef.current === id) setDataDays(res.days);
            })
            .catch(() => {});
    }, [deviceId]);

    // Storage footprint of the device's stored snapshots (count + DB bytes).
    useEffect(() => {
        const id = deviceId;
        ws.send('metrics.storage', { deviceId: id })
            .then((res) => {
                if (idRef.current === id) setStorage({ snapshots: res.snapshots, rows: res.rows, bytes: res.bytes });
            })
            .catch(() => {});
    }, [deviceId]);

    // Subscribe live to this device through the shared ref-counted store, so it
    // coexists with any other live consumer on the single socket and survives a
    // reconnect. Released on unmount (true unmount — kept-alive parking keeps it).
    useEffect(() => acquireMetrics(deviceId), [deviceId]);

    // (Re)compute the window + presence + snapshot marks + reset focus when the
    // device or the chosen day changes.
    useEffect(() => {
        const id = deviceId;
        const now = Date.now();
        // Window ends at "now" (live) or the chosen day's end, and spans `spanMs`
        // (zoom). For a past day, don't run before that day's 00:00.
        const end = dayStart === null ? now : Math.min(dayStart + DAY_MS, now);
        const floor = dayStart === null ? -Infinity : dayStart;
        const start = Math.max(floor, end - spanMs);
        setWindowRange({ start, end });
        setFocus({ kind: 'live' });
        setReport(baseDevices.find((d) => d.id === id)?.report ?? null);
        ws.send('metrics.presence', { deviceId: id, from: start, to: end })
            .then((res) => {
                if (idRef.current === id) setPresence({ onlineAtStart: res.onlineAtStart, events: res.events });
            })
            .catch(() => {});
        ws.send('metrics.snapshots', { deviceId: id, from: start, to: end })
            .then((res) => {
                if (idRef.current === id) {
                    setSnapshotTimes(res.timestamps);
                    setPinnedTimes(res.pinned);
                }
            })
            .catch(() => {});
    }, [deviceId, dayStart, spanMs]);

    // Fetch the series + processes for the current graph window / focus.
    useEffect(() => {
        const id = deviceId;
        ws.send('metrics.query', { deviceId: id, from: graphWindow.start, to: graphWindow.end, resolution })
            .then((res) => {
                if (idRef.current === id) setPoints(res.points);
            })
            .catch(() => {})
            // Reveal the graphs once the first attempt lands (success or failure),
            // so a transient error shows "no data" rather than an endless loader.
            .finally(() => {
                if (idRef.current === id) setMetricsReady(true);
            });
        ws.send('metrics.processesAt', { deviceId: id, at: processAt })
            .then((res) => {
                if (idRef.current === id) setProcSample(res.sample);
            })
            .catch(() => {});
    }, [deviceId, graphWindow.start, graphWindow.end, resolution, processAt]);

    const liveTail = focus.kind === 'live' && dayStart === null;

    // Live push handling.
    useEffect(() => {
        const off = ws.onMessage((msg) => {
            if (msg.command === METRICS_PUSH_EVENT && msg.payload.ok) {
                const push = msg.payload.data as MetricsPush;
                if (push.deviceId !== deviceId) return;
                setLiveSnapshot((prev) => mergeSnapshot(prev, push.snapshot));
                if (liveTail) {
                    setPoints((prev) =>
                        prev.length && push.snapshot.timestamp <= prev[prev.length - 1].timestamp
                            ? prev
                            : [...prev, push.snapshot]
                    );
                }
            }
            if (msg.command === DEVICE_REPORT_EVENT && msg.payload.ok) {
                const push = msg.payload.data as DeviceReportPush;
                if (push.deviceId !== deviceId) return;
                setReport(push.report);
                setOverride((p) => ({ ...p, report: push.report }));
            }
            if (msg.command === DEVICE_PRESENCE_EVENT && msg.payload.ok) {
                const pres = msg.payload.data as DevicePresence;
                if (pres.deviceId !== deviceId) return;
                setOverride((p) => ({ ...p, online: pres.online }));
                const seen = pres.lastSeen;
                if (seen) {
                    setPresence((pr) => ({ ...pr, events: [...pr.events, { ts: seen * 1000, online: pres.online }] }));
                }
            }
        });
        return off;
    }, [deviceId, liveTail]);

    // What a delete action would remove, per the current focus.
    const deleteTarget = useMemo(() => {
        if (focus.kind === 'snapshot') return { kind: 'snapshot' as const, from: focus.at, to: focus.at, count: 1 };
        if (focus.kind === 'range') {
            const count = snapshotTimes.filter((t) => t >= focus.start && t <= focus.end).length;
            return { kind: 'range' as const, from: focus.start, to: focus.end, count };
        }
        return null;
    }, [focus, snapshotTimes]);

    const pinnedSet = useMemo(() => new Set(pinnedTimes), [pinnedTimes]);

    // What a pin/unpin action targets, per the current focus: the bounds, how many
    // snapshots fall inside, and how many of those are already pinned (so the UI
    // can flip between "Conserver" and "Ne plus conserver").
    const pinTarget = useMemo(() => {
        if (focus.kind === 'snapshot') {
            return { from: focus.at, to: focus.at, count: 1, pinnedCount: pinnedSet.has(focus.at) ? 1 : 0 };
        }
        if (focus.kind === 'range') {
            const inRange = snapshotTimes.filter((t) => t >= focus.start && t <= focus.end);
            const pinnedCount = inRange.filter((t) => pinnedSet.has(t)).length;
            return { from: focus.start, to: focus.end, count: inRange.length, pinnedCount };
        }
        return null;
    }, [focus, snapshotTimes, pinnedSet]);
    // Fully pinned already → the action unpins; otherwise it pins the whole target.
    const allPinned = !!pinTarget && pinTarget.count > 0 && pinTarget.pinnedCount === pinTarget.count;

    // Re-fetch the timeline's snapshot marks (incl. pin state) for the window.
    const refreshSnapshotMarks = useCallback(() => {
        const id = idRef.current;
        ws.send('metrics.snapshots', { deviceId: id, from: windowRange.start, to: windowRange.end })
            .then((res) => {
                if (idRef.current === id) {
                    setSnapshotTimes(res.timestamps);
                    setPinnedTimes(res.pinned);
                }
            })
            .catch(() => {});
    }, [windowRange]);

    // Re-fetch the stored-snapshot footprint (count + DB bytes).
    const refreshStorage = useCallback(() => {
        const id = idRef.current;
        ws.send('metrics.storage', { deviceId: id })
            .then((res) => {
                if (idRef.current === id) setStorage({ snapshots: res.snapshots, rows: res.rows, bytes: res.bytes });
            })
            .catch(() => {});
    }, []);

    // Delete the targeted snapshot(s), then drop back to live and refresh marks.
    const deleteSnapshots = useCallback(async () => {
        const id = idRef.current;
        if (!deleteTarget) return;
        setDeleting(true);
        try {
            await ws.send('metrics.deleteSnapshots', { deviceId: id, from: deleteTarget.from, to: deleteTarget.to });
            setDeleteOpen(false);
            setFocus({ kind: 'live' });
            refreshSnapshotMarks();
            refreshStorage();
        } catch {
            // Keep the dialog open; the failure is rare (network) and retryable.
        } finally {
            setDeleting(false);
        }
    }, [deleteTarget, refreshSnapshotMarks, refreshStorage]);

    // Pin (keep past retention) or unpin the targeted snapshot(s). Unpinning may
    // delete instants already past their deadline — drop to live if so.
    const setPinned = useCallback(
        async (pinned: boolean) => {
            const id = idRef.current;
            if (!pinTarget || pinning) return;
            setPinning(true);
            try {
                const res = await ws.send('metrics.setSnapshotsPinned', {
                    deviceId: id,
                    from: pinTarget.from,
                    to: pinTarget.to,
                    pinned
                });
                if (res.deletedSnapshots > 0) setFocus({ kind: 'live' });
                refreshSnapshotMarks();
                refreshStorage();
            } catch {
                // Rare (network) and retryable; leave the UI as-is.
            } finally {
                setPinning(false);
            }
        },
        [pinTarget, pinning, refreshSnapshotMarks, refreshStorage]
    );

    // Refresh: ask the agent to push fresh data now.
    const refreshNow = useCallback(() => {
        const id = idRef.current;
        if (refreshing) return;
        setRefreshing(true);
        ws.send('metrics.refresh', { deviceId: id })
            .catch(() => {})
            .finally(() => setTimeout(() => setRefreshing(false), 1200));
    }, [refreshing]);

    // ── Derived series for the graphs ──
    const cpuS = points.map((p) => ({ t: p.timestamp, v: p.cpuPercent }));
    const ramS = points.map((p) => ({ t: p.timestamp, v: pct(p.memUsedBytes, p.memTotalBytes) }));
    const diskS = points.map((p) => ({ t: p.timestamp, v: pct(p.diskUsedBytes, p.diskTotalBytes) }));
    const netRx: { t: number; v: number }[] = [];
    const netTx: { t: number; v: number }[] = [];
    for (let i = 1; i < points.length; i++) {
        const dt = (points[i].timestamp - points[i - 1].timestamp) / 1000;
        if (dt <= 0) continue;
        netRx.push({ t: points[i].timestamp, v: Math.max(0, (points[i].netRxBytes - points[i - 1].netRxBytes) / dt) });
        netTx.push({ t: points[i].timestamp, v: Math.max(0, (points[i].netTxBytes - points[i - 1].netTxBytes) / dt) });
    }
    // Disk I/O rates (counters present only on snapshot rows; skip the null gaps).
    const diskRead: { t: number; v: number }[] = [];
    const diskWrite: { t: number; v: number }[] = [];
    let prevIO: { t: number; r: number | null; w: number | null } | null = null;
    for (const p of points) {
        if (p.diskReadBytes == null && p.diskWriteBytes == null) continue;
        if (prevIO) {
            const dt = (p.timestamp - prevIO.t) / 1000;
            if (dt > 0) {
                if (p.diskReadBytes != null && prevIO.r != null)
                    diskRead.push({ t: p.timestamp, v: Math.max(0, (p.diskReadBytes - prevIO.r) / dt) });
                if (p.diskWriteBytes != null && prevIO.w != null)
                    diskWrite.push({ t: p.timestamp, v: Math.max(0, (p.diskWriteBytes - prevIO.w) / dt) });
            }
        }
        prevIO = { t: p.timestamp, r: p.diskReadBytes, w: p.diskWriteBytes };
    }
    const tempS = points.filter((p) => p.cpuTempC !== null).map((p) => ({ t: p.timestamp, v: p.cpuTempC as number }));
    const gpuS = points
        .filter((p) => p.gpuPercent !== null)
        .map((p) => ({ t: p.timestamp, v: p.gpuPercent as number }));
    const batteryS = points
        .filter((p) => p.batteryPercent !== null)
        .map((p) => ({ t: p.timestamp, v: p.batteryPercent as number }));

    // Value to show in the KPI cards, per focus.
    const display = useMemo<MetricSnapshot | null>(() => {
        if (focus.kind === 'range') return averageSnapshot(points);
        if (focus.kind === 'snapshot') return nearestPoint(points, focus.at);
        return liveSnapshot ?? (points.length ? points[points.length - 1] : null);
    }, [focus, points, liveSnapshot]);
    const averaged = focus.kind === 'range';

    const lastKnown = liveSnapshot ?? (points.length ? points[points.length - 1] : null);
    const online = selected?.online ?? false;
    const archived = selected?.status === 'archived';
    const cores = report?.os.cores ?? 0;
    const valuesMuted = !online && focus.kind === 'live';

    // Processus KPI — always rendered for stability; `procStale` marks a value that
    // isn't the current live one (offline, or older than one snapshot cycle), so the
    // UI prefixes "~" and the hint gives its age. The card never disappears silently.
    const procView =
        focus.kind === 'range'
            ? { count: display?.processCount ?? null, at: null as number | null, averaged: true }
            : focus.kind === 'snapshot'
              ? { count: display?.processCount ?? null, at: focus.at, averaged: false }
              : { count: lastProc?.count ?? null, at: lastProc?.at ?? null, averaged: false };
    const procStale =
        focus.kind === 'live' &&
        procView.count != null &&
        (!online || procView.at == null || Date.now() - procView.at > snapshotIntervalMs * 1.5);
    const procAgeMin = Math.max(1, Math.round(snapshotIntervalMs / 60000));
    const ageLabel = (ts: number) => {
        const a = formatAgo(ts);
        return a === "à l'instant" ? a : `il y a ${a}`;
    };

    const focusCaption =
        focus.kind === 'snapshot'
            ? `Valeurs à ${new Date(focus.at).toLocaleString('fr-FR')}`
            : focus.kind === 'range'
              ? `Moyenne sur la sélection · ${new Date(focus.start).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })} – ${new Date(focus.end).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`
              : online
                ? 'En direct'
                : 'Dernières valeurs connues';

    // ── Graph definitions: a compact stat by default, full stats on click ──
    const fmtPct1 = (v: number) => `${v.toFixed(0)}%`;
    const fmtTemp = (v: number) => `${v.toFixed(0)}°C`;
    const compact = (text: string) => <span className={styles.graphStat}>{text}</span>;
    const openGraph = (
        title: string,
        series: Series[],
        yMax: number | undefined,
        rows: DetailRow[],
        format?: (v: number) => string
    ) =>
        void openInfo({
            title,
            body: <GraphDetail series={series} yMax={yMax} rows={rows} period={graphWindow} format={format} />,
            width: 520
        });

    type S = ReturnType<typeof stats>;
    const unitRows = (s: S, fmt: (v: number) => string): DetailRow[] =>
        s
            ? [
                  { label: 'Actuel', value: fmt(s.cur) },
                  { label: 'Moyenne', value: fmt(s.avg) },
                  { label: 'Minimum', value: fmt(s.min) },
                  { label: 'Maximum', value: fmt(s.max) }
              ]
            : [{ label: 'Aucune donnée', value: '—' }];
    const pctRows = (s: S, used?: number, total?: number): DetailRow[] => {
        const rows = unitRows(s, fmtPct1);
        if (used != null && total != null && total > 0) {
            rows.push({ label: 'Utilisé', value: `${formatBytes(used)} / ${formatBytes(total)}` });
        }
        return rows;
    };
    const rateRows = (label: string, s: S): DetailRow[] =>
        s
            ? [
                  { label: `${label} — actuel`, value: formatRate(s.cur) },
                  { label: `${label} — moyenne`, value: formatRate(s.avg) },
                  { label: `${label} — maximum`, value: formatRate(s.max) }
              ]
            : [];

    const ramUsed = display?.memUsedBytes ?? 0;
    const ramTotal = display?.memTotalBytes ?? 0;
    const diskUsed = display?.diskUsedBytes ?? 0;
    const diskTotal = display?.diskTotalBytes ?? 0;
    // Disk detail: aggregate stats + a per-disk breakdown (from the latest report).
    const diskDetailRows: DetailRow[] = [
        ...pctRows(stats(diskS), diskUsed, diskTotal),
        ...(report?.disks ?? []).map((d) => ({
            label: d.mount,
            value: `${formatBytes(d.usedBytes)} / ${formatBytes(d.totalBytes)} · ${pct(d.usedBytes, d.totalBytes).toFixed(0)}%`
        }))
    ];
    const cpuColor = [{ points: cpuS, color: 'var(--accent)' }];
    const ramSeries = [{ points: ramS, color: 'var(--accent)' }];
    const netSeries = [
        { points: netRx, color: 'var(--accent)', label: 'Réception' },
        { points: netTx, color: 'var(--warning)', label: 'Émission' }
    ];
    const diskSeries = [{ points: diskS, color: 'var(--accent)' }];
    const ioSeries = [
        { points: diskRead, color: 'var(--accent)', label: 'Lecture' },
        { points: diskWrite, color: 'var(--warning)', label: 'Écriture' }
    ];

    const allGraphs: { key: string; node: React.ReactNode }[] = [
        {
            key: 'cpu',
            node: (
                <MiniGraph
                    key='cpu'
                    title='CPU'
                    series={cpuColor}
                    yMax={100}
                    stat={compact(fmtPct1(display?.cpuPercent ?? stats(cpuS)?.cur ?? 0))}
                    onClick={() => openGraph('CPU', cpuColor, 100, unitRows(stats(cpuS), fmtPct1), fmtPct1)}
                />
            )
        },
        {
            key: 'ram',
            node: (
                <MiniGraph
                    key='ram'
                    title='RAM'
                    series={ramSeries}
                    yMax={100}
                    stat={compact(
                        `${fmtPct1(pct(ramUsed, ramTotal))} · ${formatBytes(ramUsed)} / ${formatBytes(ramTotal)}`
                    )}
                    onClick={() => openGraph('RAM', ramSeries, 100, pctRows(stats(ramS), ramUsed, ramTotal), fmtPct1)}
                />
            )
        },
        {
            key: 'net',
            node: (
                <MiniGraph
                    key='net'
                    title='Réseau ↑↓'
                    series={netSeries}
                    stat={compact(`↓ ${formatRate(netRx.at(-1)?.v ?? 0)} · ↑ ${formatRate(netTx.at(-1)?.v ?? 0)}`)}
                    onClick={() =>
                        openGraph(
                            'Réseau',
                            netSeries,
                            undefined,
                            [...rateRows('Réception', stats(netRx)), ...rateRows('Émission', stats(netTx))],
                            formatRate
                        )
                    }
                />
            )
        },
        {
            key: 'disk',
            node: (
                <MiniGraph
                    key='disk'
                    title='Disque'
                    series={diskSeries}
                    yMax={100}
                    stat={compact(
                        `${fmtPct1(pct(diskUsed, diskTotal))} · ${formatBytes(diskUsed)} / ${formatBytes(diskTotal)}`
                    )}
                    onClick={() => openGraph('Disque', diskSeries, 100, diskDetailRows, fmtPct1)}
                />
            )
        }
    ];
    if (diskRead.length > 0 || diskWrite.length > 0) {
        allGraphs.push({
            key: 'diskio',
            node: (
                <MiniGraph
                    key='diskio'
                    title='Disque E/S'
                    series={ioSeries}
                    stat={compact(
                        `L ${formatRate(diskRead.at(-1)?.v ?? 0)} · É ${formatRate(diskWrite.at(-1)?.v ?? 0)}`
                    )}
                    onClick={() =>
                        openGraph(
                            'Disque E/S',
                            ioSeries,
                            undefined,
                            [...rateRows('Lecture', stats(diskRead)), ...rateRows('Écriture', stats(diskWrite))],
                            formatRate
                        )
                    }
                />
            )
        });
    }
    if (tempS.length > 0) {
        allGraphs.push({
            key: 'temp',
            node: (
                <MiniGraph
                    key='temp'
                    title='Température'
                    series={[{ points: tempS, color: 'var(--warning)' }]}
                    stat={compact(fmtTemp(display?.cpuTempC ?? stats(tempS)?.cur ?? 0))}
                    onClick={() =>
                        openGraph(
                            'Température',
                            [{ points: tempS, color: 'var(--warning)' }],
                            undefined,
                            unitRows(stats(tempS), fmtTemp),
                            fmtTemp
                        )
                    }
                />
            )
        });
    }
    if (gpuS.length > 0) {
        allGraphs.push({
            key: 'gpu',
            node: (
                <MiniGraph
                    key='gpu'
                    title='GPU'
                    series={[{ points: gpuS, color: 'var(--accent)' }]}
                    yMax={100}
                    stat={compact(fmtPct1(display?.gpuPercent ?? stats(gpuS)?.cur ?? 0))}
                    onClick={() =>
                        openGraph(
                            'GPU',
                            [{ points: gpuS, color: 'var(--accent)' }],
                            100,
                            unitRows(stats(gpuS), fmtPct1),
                            fmtPct1
                        )
                    }
                />
            )
        });
    }
    if (batteryS.length > 0) {
        const battSeries = [{ points: batteryS, color: 'var(--success, #3ecf8e)' }];
        const battCur = display?.batteryPercent ?? stats(batteryS)?.cur ?? 0;
        allGraphs.push({
            key: 'battery',
            node: (
                <MiniGraph
                    key='battery'
                    title='Batterie'
                    series={battSeries}
                    yMax={100}
                    stat={compact(`${fmtPct1(battCur)}${display?.batteryCharging ? ' ⚡' : ''}`)}
                    onClick={() => openGraph('Batterie', battSeries, 100, unitRows(stats(batteryS), fmtPct1), fmtPct1)}
                />
            )
        });
    }
    const shownGraphs = graphsExpanded ? allGraphs : allGraphs.slice(0, COLLAPSED_GRAPHS);

    // Activity level from the focused snapshot (idle / normal / intensive).
    const activity = activityLevel(display, cores);
    const activityMeta = ACTIVITY_META[activity];

    const showHardwareInfo = () =>
        selected &&
        void openInfo({
            title: `Matériel — ${selected.name}`,
            body: <HardwareInfo report={report} device={selected} />,
            width: 560
        });

    const showConnections = () =>
        void openInfo({ title: 'Connexions TCP établies', body: <Connections report={report} />, width: 560 });

    const showPrivilegeInfo = () =>
        selected &&
        void openInfo({
            title: 'Accès & privilèges de l’agent',
            body: <PrivilegeInfo agent={report?.agent ?? null} platform={selected.platform} />,
            width: 560
        });

    if (!selected) {
        return (
            <div className={styles.metricsPanel}>
                <p className={styles.waitingMsg}>{loading ? 'Chargement…' : 'Appareil introuvable ou supprimé.'}</p>
            </div>
        );
    }

    return (
        <div className={styles.metricsPanel}>
            <div className={styles.metricsPanelHeader}>
                <h3>{selected.name}</h3>
                <div className={styles.headerRight}>
                    {online && !archived && agentUpdatable(selected) && (
                        <button
                            className={`${styles.iconHeaderBtn} ${styles.iconHeaderUpdate}`}
                            onClick={() => void updater.update(selected.id)}
                            disabled={updater.isBusy(selected.id)}
                            title={
                                selected.latestAgentVersion
                                    ? `Mettre à jour l’agent vers la v${selected.latestAgentVersion}`
                                    : 'Mettre à jour l’agent'
                            }
                        >
                            <span
                                className={`icon ${updater.isBusy(selected.id) ? `icon-spinner ${styles.spinning}` : 'icon-cloud'}`}
                            />
                        </button>
                    )}
                    <button className={styles.iconHeaderBtn} onClick={showHardwareInfo} title='Matériel & agent'>
                        <span className='icon icon-cpu' />
                    </button>
                    {!archived && (
                        <button
                            className={styles.iconHeaderBtn}
                            onClick={() => setConfigOpen(true)}
                            title='Configurer la collecte'
                        >
                            <span className='icon icon-settings' />
                        </button>
                    )}
                    {online && !archived && (
                        <button
                            className={styles.iconHeaderBtn}
                            onClick={() => setPackagesOpen(true)}
                            title='Mises à jour système'
                        >
                            <span className='icon icon-database' />
                        </button>
                    )}
                    {online && !archived && (
                        <button
                            className={styles.iconHeaderBtn}
                            onClick={refreshNow}
                            disabled={refreshing}
                            title='Rafraîchir maintenant'
                        >
                            <span className={`icon icon-refresh ${refreshing ? styles.spinning : ''}`} />
                        </button>
                    )}
                    {archived ? (
                        <span className={`${styles.onlineBadge} ${styles.archived}`}>Archivé</span>
                    ) : (
                        <span className={`${styles.onlineBadge} ${online ? styles.online : styles.offline}`}>
                            {online ? 'En ligne' : 'Hors ligne'}
                        </span>
                    )}
                </div>
            </div>

            {display ? (
                <div
                    className={`${styles.activityHero} ${styles[activityMeta.cls]} ${valuesMuted ? styles.muted : ''}`}
                >
                    <span className={styles.activityDot} />
                    <span className={styles.activityLabel}>{activityMeta.label}</span>
                    <span className={`icon icon-activity ${styles.activityIcon}`} />
                </div>
            ) : !metricsReady ? (
                <div className={`${styles.activityHero} ${styles.activityHeroLoading}`} aria-hidden>
                    <span className={styles.activityDot} />
                    <div className={`${styles.skelLine} ${styles.skelHeroLabel}`} />
                </div>
            ) : null}

            {!online && (
                <div className={styles.offlineBanner}>
                    <span className='icon icon-clock' />
                    Hors ligne
                    {selected.lastSeen ? ` depuis ${formatAgo(selected.lastSeen * 1000)}` : ''}
                    {lastKnown
                        ? ` · dernières données le ${new Date(lastKnown.timestamp).toLocaleString('fr-FR')}`
                        : ''}
                </div>
            )}

            {/* Timeline + day navigation */}
            <Timeline
                windowStart={windowRange.start}
                windowEnd={windowRange.end}
                onlineAtStart={presence.onlineAtStart}
                events={presence.events}
                snapshotTimes={snapshotTimes}
                pinnedTimes={pinnedTimes}
                selection={focus.kind === 'range' ? { start: focus.start, end: focus.end } : null}
                pointAt={focus.kind === 'snapshot' ? focus.at : null}
                onSelectRange={(sel) => setFocus({ kind: 'range', ...sel })}
                onPickSnapshot={(at) => setFocus({ kind: 'snapshot', at })}
                onLive={() => {
                    setDayStart(null);
                    setFocus({ kind: 'live' });
                }}
                dayStart={dayStart}
                onDayChange={setDayStart}
                dataDays={dataDays}
                spanMs={spanMs}
                zoomPresets={ZOOM_PRESETS}
                onSpanChange={setSpanMs}
            />

            {/* Graphs */}
            <div className={styles.graphsSpan} title='Durée couverte par les graphiques'>
                <span className='icon icon-clock' />
                <span>{formatDuration(graphWindow.end - graphWindow.start)}</span>
            </div>
            <div className={styles.graphsGrid}>
                {metricsReady
                    ? shownGraphs.map((g) => g.node)
                    : Array.from({ length: COLLAPSED_GRAPHS }).map((_, i) => (
                          <div key={`graph-skeleton-${i}`} className={styles.graphCard} aria-hidden>
                              <div className={styles.graphHead}>
                                  <div className={`${styles.skelLine} ${styles.skelTitle}`} />
                                  <div className={`${styles.skelLine} ${styles.skelStat}`} />
                              </div>
                              <div className={`${styles.skelLine} ${styles.skelGraphBody}`} />
                          </div>
                      ))}
            </div>
            {metricsReady && allGraphs.length > COLLAPSED_GRAPHS && (
                <button className={styles.expandGraphsBtn} onClick={() => setGraphsExpanded((v) => !v)}>
                    {graphsExpanded
                        ? 'Réduire les graphiques'
                        : `Afficher plus de graphiques (+${allGraphs.length - COLLAPSED_GRAPHS})`}
                </button>
            )}

            {/* Current / focused values */}
            {display && (
                <>
                    <p className={styles.focusCaption}>{focusCaption}</p>
                    <div className={styles.infoGrid}>
                        <InfoCard
                            label='Disque'
                            muted={valuesMuted}
                            value={`${pct(display.diskUsedBytes, display.diskTotalBytes).toFixed(0)}%`}
                        />
                        {display.batteryPercent !== null && (
                            <InfoCard
                                label='Batterie'
                                value={`${display.batteryPercent.toFixed(0)}%${display.batteryCharging ? ' ⚡' : ''}`}
                                muted={valuesMuted}
                                hint={
                                    display.batteryCharging === null
                                        ? undefined
                                        : display.batteryCharging
                                          ? 'En charge / sur secteur'
                                          : 'Sur batterie'
                                }
                            />
                        )}
                        <InfoCard
                            label={averaged ? 'Utilisateurs (moy.)' : 'Utilisateurs'}
                            value={String(display.usersCount)}
                            muted={valuesMuted}
                        />
                        <InfoCard
                            label={procView.averaged ? 'Processus (moy.)' : 'Processus'}
                            value={procView.count == null ? '—' : `${procStale ? '~' : ''}${procView.count}`}
                            muted={valuesMuted}
                            hint={
                                procView.count == null
                                    ? `Aucun relevé de processus pour le moment (relevé périodique, ~${procAgeMin} min)`
                                    : procView.at != null
                                      ? `Nombre total de processus · relevé ${ageLabel(procView.at)} (périodique, ~${procAgeMin} min)`
                                      : 'Nombre total de processus (moyenne sur la sélection)'
                            }
                        />
                        {display.activeConnections !== null && (
                            <InfoCard
                                label={averaged ? 'Connexions (moy.)' : 'Connexions'}
                                value={String(display.activeConnections)}
                                muted={valuesMuted}
                                hint='Connexions TCP établies — cliquer pour le détail'
                                onClick={report?.connections ? showConnections : undefined}
                            />
                        )}
                        {display.uptimeSeconds !== null && (
                            <InfoCard
                                label='Uptime'
                                value={formatUptime(display.uptimeSeconds)}
                                muted={valuesMuted}
                                hint='Temps écoulé depuis le démarrage de la machine'
                            />
                        )}
                    </div>
                </>
            )}

            {/* Security */}
            <div className={styles.section}>
                <h4 className={styles.sectionTitle}>Sécurité</h4>
                {report ? (
                    <div className={styles.secGrid}>
                        <SecurityChip label='Pare-feu' value={report.security.firewall} />
                        <SecurityChip label='Chiffrement disque' value={report.security.diskEncryption} />
                        {selected.platform === 'macos' && <SecurityChip label='SIP' value={report.security.sip} />}
                        {report.security.pendingUpdates !== null && (
                            <div
                                className={`${styles.secChip} ${report.security.pendingUpdates > 0 ? styles.secWarn : styles.secGood}`}
                            >
                                <span className={styles.secLabel}>MAJ en attente</span>
                                <span className={styles.secVal}>{report.security.pendingUpdates}</span>
                            </div>
                        )}
                        {report.agent && (
                            <button
                                type='button'
                                className={`${styles.secChip} ${styles.secChipBtn} ${report.agent.privileged ? styles.secGood : styles.secUnknown}`}
                                onClick={showPrivilegeInfo}
                                title={`Agent exécuté sous « ${report.agent.user || 'inconnu'} » — pourquoi certaines mesures sont limitées`}
                            >
                                <span className={styles.secLabel}>Privilèges agent</span>
                                <span className={styles.secVal}>
                                    {report.agent.privileged
                                        ? selected.platform === 'windows'
                                            ? 'élevé'
                                            : 'root'
                                        : 'limité'}
                                    <span className='icon icon-info' />
                                </span>
                            </button>
                        )}
                    </div>
                ) : (
                    <p className={styles.waitingMsg}>Aucun bilan de sécurité.</p>
                )}
            </div>

            {/* Open listening ports */}
            <div className={styles.section}>
                <h4 className={styles.sectionTitle}>
                    Ports en écoute
                    {report?.openPorts && report.openPorts.length > 0 && (
                        <span className={styles.sectionMeta}>
                            {report.openPorts.length} port{report.openPorts.length > 1 ? 's' : ''}
                        </span>
                    )}
                </h4>
                {report ? <OpenPorts ports={report.openPorts} /> : <p className={styles.waitingMsg}>Aucun bilan.</p>}
            </div>

            {/* Processes at the selected moment */}
            <div className={styles.section}>
                <h4 className={styles.sectionTitle}>
                    Processus les plus actifs
                    {procSample && (
                        <span
                            className={styles.sectionMeta}
                            title={`Relevé périodique (~${procAgeMin} min), pas en temps réel · ${new Date(procSample.ts).toLocaleString('fr-FR')}`}
                        >
                            {procSample.kind === 'all' ? 'Relevé complet' : 'Top 20'} · {procSample.processes.length}{' '}
                            processus · relevé {ageLabel(procSample.ts)} (
                            {new Date(procSample.ts).toLocaleTimeString('fr-FR', {
                                hour: '2-digit',
                                minute: '2-digit'
                            })}
                            )
                        </span>
                    )}
                </h4>

                {/* Snapshot footprint + per-snapshot / per-zone deletion */}
                <div className={styles.snapshotBar}>
                    <span
                        className={styles.snapshotUsage}
                        title='Espace occupé en base par les snapshots de cet appareil'
                    >
                        <span className='icon icon-server' />
                        {storage
                            ? `${storage.snapshots} snapshot${storage.snapshots > 1 ? 's' : ''} · ≈ ${formatBytesFr(storage.bytes)} en base`
                            : 'Calcul de l’espace…'}
                    </span>
                    <div className={styles.snapshotActions}>
                        {pinTarget && pinTarget.count > 0 && (
                            <button
                                type='button'
                                className={`${styles.snapshotPinBtn} ${allPinned ? styles.snapshotPinBtnActive : ''}`}
                                onClick={() => void setPinned(!allPinned)}
                                disabled={pinning}
                                title={
                                    allPinned
                                        ? 'Lever la conservation : le(s) snapshot(s) pourront de nouveau être nettoyés'
                                        : 'Conserver indéfiniment : ce(s) snapshot(s) ignore(nt) le nettoyage automatique'
                                }
                            >
                                <span className={`icon ${allPinned ? 'icon-star' : 'icon-star-outline'}`} />
                                {pinTarget.count > 1
                                    ? allPinned
                                        ? `Ne plus conserver (${pinTarget.count})`
                                        : `Conserver la zone (${pinTarget.count})`
                                    : allPinned
                                      ? 'Ne plus conserver'
                                      : 'Conserver'}
                            </button>
                        )}
                        {deleteTarget && (deleteTarget.kind === 'snapshot' || deleteTarget.count > 0) && (
                            <button
                                type='button'
                                className={styles.snapshotDeleteBtn}
                                onClick={() => setDeleteOpen(true)}
                                title={
                                    deleteTarget.kind === 'snapshot'
                                        ? 'Supprimer le snapshot sélectionné'
                                        : 'Supprimer les snapshots de la zone sélectionnée'
                                }
                            >
                                <span className='icon icon-trash' />
                                {deleteTarget.kind === 'snapshot'
                                    ? 'Supprimer ce snapshot'
                                    : `Supprimer la zone (${deleteTarget.count})`}
                            </button>
                        )}
                    </div>
                </div>

                {procSample && procSample.processes.length > 0 ? (
                    <>
                        <table className={styles.procTable}>
                            <thead>
                                <tr>
                                    <th>Nom</th>
                                    <th
                                        className={styles.procNum}
                                        title={
                                            cores > 0
                                                ? `% rapporté aux ${cores} cœurs (0–100 % = machine entière). Survolez une valeur pour le cumul brut.`
                                                : 'Utilisation CPU'
                                        }
                                    >
                                        CPU{cores > 0 ? ' %' : ''}
                                    </th>
                                    <th className={styles.procNum}>Mémoire</th>
                                </tr>
                            </thead>
                            <tbody>
                                {procSample.processes.slice(0, showAllProcs ? undefined : 12).map((p, i) => {
                                    const cpuNorm = cores > 0 ? Math.min(100, p.cpuPercent / cores) : p.cpuPercent;
                                    return (
                                        <tr key={`${p.name}-${i}`}>
                                            <td className={styles.procName}>{p.name}</td>
                                            <td
                                                className={styles.procNum}
                                                title={
                                                    cores > 0
                                                        ? `${p.cpuPercent.toFixed(0)} % cumulé sur ${cores} cœurs`
                                                        : undefined
                                                }
                                            >
                                                {cpuNorm.toFixed(1)}%
                                            </td>
                                            <td className={styles.procNum}>{formatBytes(p.memBytes)}</td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                        {procSample.processes.length > 12 && (
                            <button className={styles.expandGraphsBtn} onClick={() => setShowAllProcs((v) => !v)}>
                                {showAllProcs
                                    ? 'Réduire'
                                    : `Afficher tout (${procSample.processes.length - 12} de plus)`}
                            </button>
                        )}
                    </>
                ) : (
                    <p className={styles.waitingMsg}>
                        {focus.kind === 'live'
                            ? `Pas encore de relevé de processus (relevé périodique, ~${procAgeMin} min).`
                            : 'Aucun relevé de processus sur cette période.'}
                    </p>
                )}
            </div>

            <div className={styles.deviceMeta}>
                {report && (
                    <span>
                        OS : {report.os.name} {report.os.version} ({report.os.arch})
                    </span>
                )}
                <span>Plateforme : {selected.platform}</span>
            </div>

            <ConfigDialog
                open={configOpen}
                device={selected}
                onClose={() => setConfigOpen(false)}
                onSaved={() => void refresh()}
            />

            <Dialog
                open={packagesOpen}
                onClose={() => setPackagesOpen(false)}
                title={`Mises à jour — « ${selected.name} »`}
                description='Gestionnaires détectés sur l’appareil et application des mises à jour en direct.'
                footer={
                    <Button variant='secondary' onClick={() => setPackagesOpen(false)}>
                        Fermer
                    </Button>
                }
            >
                {packagesOpen && <PackagesPanel deviceId={selected.id} />}
            </Dialog>

            <Dialog
                open={deleteOpen}
                onClose={() => setDeleteOpen(false)}
                title={
                    deleteTarget?.kind === 'range' ? 'Supprimer les snapshots de la zone ?' : 'Supprimer ce snapshot ?'
                }
                description='Cette action efface définitivement les relevés de processus sélectionnés.'
                onSubmit={() => void deleteSnapshots()}
                footer={
                    <>
                        <Button variant='secondary' onClick={() => setDeleteOpen(false)} disabled={deleting}>
                            Annuler
                        </Button>
                        <Button variant='danger' onClick={() => void deleteSnapshots()} disabled={deleting}>
                            {deleting ? 'Suppression…' : 'Supprimer'}
                        </Button>
                    </>
                }
            >
                <p className={styles.focusCaption}>
                    {deleteTarget?.kind === 'range'
                        ? `${deleteTarget.count} snapshot${deleteTarget.count > 1 ? 's' : ''} entre ${new Date(deleteTarget.from).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })} et ${new Date(deleteTarget.to).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })} seront supprimés. Les graphiques de métriques ne sont pas affectés.`
                        : `Le snapshot du ${deleteTarget ? new Date(deleteTarget.from).toLocaleString('fr-FR') : ''} et sa liste de processus seront supprimés. Les graphiques de métriques ne sont pas affectés.`}
                </p>
            </Dialog>
        </div>
    );
}
