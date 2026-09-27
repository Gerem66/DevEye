import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    acquireMetrics,
    Button,
    Dialog,
    FeatureSettingsButton,
    onServerEvent,
    openInfo,
    PlanPausedBadge,
    useWorkspacePermissions
} from 'deveye-sdk-client';
import {
    DEVICE_PRESENCE_EVENT,
    DEVICE_REPORT_EVENT,
    devicePresenceSchema,
    deviceReportPushSchema,
    METRICS_PUSH_EVENT,
    metricsPushSchema,
    type AgentPolicy,
    type DeviceReport,
    type MetricSeriesPoint,
    type ReportProcess,
    type MetricsResolution,
    type PresenceEvent,
    type ProcessSample
} from '@deveye/types';
import type { DaySummary } from '../contracts/commands';
import { AgentPanel } from './AgentPanel';
import { HardwareInfo } from './HardwareInfo';
import { Connections } from './Connections';
import { DeviceActionsMenu, type DeviceAction } from './DeviceActionsMenu';
import { agentReach, firstReason, LOCAL_POLICY, missingPermission, OLD_AGENT, type Unavailable } from './availability';
import { PrivilegeInfo } from './PrivilegeInfo';
import { OpenPorts } from './OpenPorts';
import { groupPorts } from './ports';
import { GraphDetail, type DetailRow } from './GraphDetail';
import { Timeline } from './Timeline';
import { MiniGraph, type Series } from './MiniGraph';
import { PackagesPanel } from './PackagesPanel';
import { PowerMenu } from './PowerMenu';
import { LogsPanel } from './LogsPanel';
import { useAgentUpdate } from './useAgentUpdate';
import { DeviceDialogs } from './manage/DeviceDialogs';
import { deviceLifecycleActions } from './manage/lifecycleActions';
import { useDeviceActions } from './manage/useDeviceActions';

// xterm.js and the file explorer are heavy and rarely opened: loaded on demand.
const TerminalPanel = lazy(() => import('./TerminalPanel').then((m) => ({ default: m.TerminalPanel })));
const FilesPanel = lazy(() => import('./FilesPanel').then((m) => ({ default: m.FilesPanel })));
const DockerPanel = lazy(() => import('./DockerPanel').then((m) => ({ default: m.DockerPanel })));
import { agentUpdatable } from './agentVersion';
import { agent, api } from './api';
import { useDevices } from './store';
import {
    ACTIVITY_META,
    activityLevel,
    formatAgo,
    formatBytes,
    formatBytesFr,
    formatDuration,
    formatRate,
    formatUptime,
    nearestBy,
    pct
} from './utils';
import styles from './style.module.css';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Mirrors the server's default collection cadence (`DEFAULT_METRIC_INTERVAL_SECONDS`). */
const DEFAULT_INTERVAL_S = 60;
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
 * - `snapshot`: a single instant — exact KPIs/processes, graphs over the cadence
 *   around it (fine resolution).
 */
type Focus = { kind: 'live' } | { kind: 'range'; start: number; end: number } | { kind: 'snapshot'; at: number };

/** Secondary process facts, shown on hover rather than as more columns. */
function processTitle(p: ReportProcess): string {
    const bits: string[] = [];
    if (p.instances > 1) bits.push(`${p.instances} processus`);
    if (p.user) bits.push(`utilisateur ${p.user}`);
    if (p.threads !== null) bits.push(`${p.threads} threads`);
    if (p.uptimeSeconds !== null) bits.push(`démarré depuis ${formatUptime(p.uptimeSeconds)}`);
    return bits.join(' · ');
}

/** Bucketing resolution to keep the query light at wide zoom levels. */
function spanResolution(spanMs: number): MetricsResolution {
    if (spanMs <= 60 * 60 * 1000) return 'raw';
    if (spanMs <= 12 * 60 * 60 * 1000) return 'minute';
    return 'hour';
}

/**
 * Keep last-known values for the genuinely optional probes: null because the
 * machine has no such sensor or the agent lacks privileges, not because of the
 * collection cycle.
 */
const SPARSE_FIELDS: (keyof MetricSeriesPoint)[] = [
    'gpuPercent',
    'cpuTempC',
    'loadAvg1',
    'batteryPercent',
    'diskReadBytes',
    'diskWriteBytes'
];
function mergeSnapshot(prev: MetricSeriesPoint | null, next: MetricSeriesPoint): MetricSeriesPoint {
    if (!prev) return next;
    const out = { ...next };
    for (const k of SPARSE_FIELDS) {
        if (out[k] == null && prev[k] != null) (out[k] as number | null) = prev[k] as number | null;
    }
    return out;
}

/** A synthetic snapshot whose gauges/counters are averaged over `points`. */
function averageSnapshot(points: MetricSeriesPoint[]): MetricSeriesPoint | null {
    if (points.length === 0) return null;
    const last = points[points.length - 1];
    const avg = (sel: (p: MetricSeriesPoint) => number | null): number | null => {
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
    const avgRound = (sel: (p: MetricSeriesPoint) => number | null): number | null => {
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
 * Per-device monitoring panel, reused by the full Monitoring view and by the
 * home device tile's popup. Owns the device's live state (presence, report,
 * metric pushes) and its metric subscription.
 */
export default function MonitoringPanel({ deviceId }: MonitoringPanelProps) {
    const { devices: baseDevices, loading, refresh } = useDevices();
    const permissions = useWorkspacePermissions();
    // Sur CET appareil, et non sur la fonctionnalité : une surcharge peut ouvrir
    // l'écriture ici à un rôle qui ne l'a que sur d'autres machines.
    const canWrite = permissions.canFeature('devices', 'write', deviceId);
    // Les gestes de cycle de vie et leurs dialogues, montés avec la fiche.
    const actions = useDeviceActions(refresh);
    const [override, setOverride] = useState<{ online?: boolean; report?: DeviceReport | null }>({});
    const [packagesOpen, setPackagesOpen] = useState(false);
    const [powerOpen, setPowerOpen] = useState(false);
    const [logsOpen, setLogsOpen] = useState(false);
    const [dockerOpen, setDockerOpen] = useState(false);
    const [terminalOpen, setTerminalOpen] = useState(false);
    const [filesOpen, setFilesOpen] = useState(false);
    const [agentOpen, setAgentOpen] = useState(false);
    const updater = useAgentUpdate();
    const [storage, setStorage] = useState<{ snapshots: number; processes: number; bytes: number } | null>(null);
    const [deleteOpen, setDeleteOpen] = useState(false);
    const [deleting, setDeleting] = useState(false);
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
    // Subset of `snapshotTimes` whose process list was recorded: empty with
    // `processCapture: 'off'`, and the process-only actions know it.
    const [procTimes, setProcTimes] = useState<number[]>([]);
    const [points, setPoints] = useState<MetricSeriesPoint[]>([]);
    // Two sources, never merged: the latest pushed instant and the one fetched
    // for a focused past instant. "Direct" shows live processes again at once.
    const [liveProc, setLiveProc] = useState<ProcessSample | null>(null);
    const [histProc, setHistProc] = useState<ProcessSample | null>(null);
    const [showAllProcs, setShowAllProcs] = useState(false);
    const [report, setReport] = useState<DeviceReport | null>(null);
    const [liveSnapshot, setLiveSnapshot] = useState<MetricSeriesPoint | null>(null);
    const [refreshing, setRefreshing] = useState(false);
    const [dataDays, setDataDays] = useState<DaySummary[]>([]);
    const [graphsExpanded, setGraphsExpanded] = useState(false);
    // False until the first metrics query resolves: the graphs and activity
    // hero come only from that query, everything else is seeded by the push.
    const [metricsReady, setMetricsReady] = useState(false);
    /**
     * Une lecture de supervision a échoué. Un seul drapeau : la panne est la
     * même pour toutes les lectures (la socket), et il se lève dès que l'une
     * d'elles repasse. Sans lui, un échec réseau ressemble à une machine sans
     * données.
     */
    const [readError, setReadError] = useState(false);
    /**
     * La fenêtre contenait plus d'instants que le serveur n'en rend : seuls les
     * plus récents sont là, sinon la frise s'arrête au milieu sans raison apparente.
     */
    const [timelineTruncated, setTimelineTruncated] = useState(false);

    const baseDevice = baseDevices.find((d) => d.id === deviceId) ?? null;
    const selected = baseDevice ? { ...baseDevice, ...override } : null;
    const idRef = useRef<string>(deviceId);
    idRef.current = deviceId;

    const intervalMs = (selected?.metricIntervalSeconds ?? DEFAULT_INTERVAL_S) * 1000;

    // The time window the graphs cover, derived from the focus.
    const graphWindow = useMemo(() => {
        if (focus.kind === 'range') return { start: focus.start, end: focus.end };
        // A single instant: show the cadence around it, at raw resolution.
        if (focus.kind === 'snapshot') {
            return { start: Math.max(0, focus.at - intervalMs * 10), end: focus.at };
        }
        return windowRange;
    }, [focus, windowRange, intervalMs]);
    const resolution = spanResolution(graphWindow.end - graphWindow.start);
    // Which instant the process list describes; in live focus the pushed
    // snapshot carries its own processes.
    const processAt = focus.kind === 'snapshot' ? focus.at : focus.kind === 'range' ? focus.end : null;

    // Changing device: drop the previous machine's transient data so it never
    // bleeds into the new selection.
    useEffect(() => {
        setMetricsReady(false);
        setReadError(false);
        setTimelineTruncated(false);
        setOverride({});
        setPoints([]);
        setLiveSnapshot(null);
        setLiveProc(null);
        setHistProc(null);
        setSnapshotTimes([]);
        setPinnedTimes([]);
        setProcTimes([]);
        setStorage(null);
        setPresence({ onlineAtStart: false, events: [] });
    }, [deviceId]);

    /**
     * Épingler ou supprimer change ce que les jours contiennent, et peut vider
     * un jour entier : sans ce rappel, le calendrier et sa liste restent sur
     * l'état du montage.
     */
    const refreshAvailability = useCallback(() => {
        const id = idRef.current;
        api.send('devices.availability', { deviceId: id, tzOffsetMinutes: new Date().getTimezoneOffset() })
            .then((res) => {
                if (idRef.current === id) setDataDays(res.days);
            })
            .catch(() => setReadError(true));
    }, []);

    // Which days have data (for the calendar + day arrows).
    useEffect(() => {
        refreshAvailability();
    }, [deviceId, refreshAvailability]);

    useEffect(() => {
        const id = deviceId;
        api.send('devices.storage', { deviceId: id })
            .then((res) => {
                if (idRef.current === id)
                    setStorage({ snapshots: res.snapshots, processes: res.processes, bytes: res.bytes });
            })
            .catch(() => setReadError(true));
    }, [deviceId]);

    // Live subscription through the shared ref-counted store, so it coexists
    // with other consumers and survives a reconnect. Released on true unmount.
    useEffect(() => acquireMetrics(deviceId), [deviceId]);

    // Window, presence, snapshot marks and focus follow the device and the day.
    useEffect(() => {
        const id = deviceId;
        let cancelled = false;
        const now = Date.now();
        // The window ends at "now" or the chosen day's end, and spans `spanMs`.
        const end = dayStart === null ? now : Math.min(dayStart + DAY_MS, now);
        const floor = dayStart === null ? -Infinity : dayStart;
        const start = Math.max(floor, end - spanMs);
        setWindowRange({ start, end });
        setFocus({ kind: 'live' });
        setReport(baseDevices.find((d) => d.id === id)?.report ?? null);
        // Même garde que pour la série : deux changements de zoom rapprochés
        // laisseraient les marques d'une fenêtre sur une autre.
        api.send('devices.presence', { deviceId: id, from: start, to: end })
            .then((res) => {
                if (!cancelled && idRef.current === id)
                    setPresence({ onlineAtStart: res.onlineAtStart, events: res.events });
            })
            .catch(() => {
                if (!cancelled) setReadError(true);
            });
        api.send('devices.snapshots', { deviceId: id, from: start, to: end })
            .then((res) => {
                if (cancelled || idRef.current !== id) return;
                setSnapshotTimes(res.timestamps);
                setPinnedTimes(res.pinned);
                setProcTimes(res.withProcesses);
                setTimelineTruncated(res.truncated);
            })
            .catch(() => {
                if (!cancelled) setReadError(true);
            });
        return () => {
            cancelled = true;
        };
    }, [deviceId, dayStart, spanMs]);

    // Fetch the series + processes for the current graph window / focus. Le
    // jeton d'annulation fait qu'une réponse périmée n'écrit rien : rien ne
    // garantit l'ordre d'arrivée, et une réponse ancienne écraserait la récente.
    useEffect(() => {
        const id = deviceId;
        let cancelled = false;
        // Le squelette plutôt que les points de la fenêtre précédente, qui ne
        // veulent plus rien dire sur ce cadre.
        setMetricsReady(false);
        api.send('devices.metrics', { deviceId: id, from: graphWindow.start, to: graphWindow.end, resolution })
            .then((res) => {
                if (cancelled || idRef.current !== id) return;
                setPoints(res.points);
                setReadError(false);
            })
            .catch(() => {
                if (!cancelled) setReadError(true);
            })
            // Success or failure: a transient error shows "no data" rather than
            // an endless loader.
            .finally(() => {
                if (!cancelled && idRef.current === id) setMetricsReady(true);
            });
        // Historical focus only: in live focus the process list rides along
        // with each push.
        if (processAt !== null) {
            api.send('devices.processesAt', { deviceId: id, at: processAt })
                .then((res) => {
                    if (!cancelled && idRef.current === id) setHistProc(res.sample);
                })
                .catch(() => {
                    if (!cancelled) setReadError(true);
                });
        }
        return () => {
            cancelled = true;
        };
    }, [deviceId, graphWindow.start, graphWindow.end, resolution, processAt]);

    const liveTail = focus.kind === 'live' && dayStart === null;

    useEffect(() => {
        const offMetrics = onServerEvent(METRICS_PUSH_EVENT, metricsPushSchema, (push) => {
            if (push.deviceId !== deviceId) return;
            // Split the instant: the graph series keeps only the numbers (every
            // process list along would cost megabytes of state), the process
            // table takes the list.
            const { processes, processKind, ...point } = push.snapshot;
            setLiveSnapshot((prev) => mergeSnapshot(prev, point));
            if (processes !== null) {
                setLiveProc({ ts: push.snapshot.timestamp, kind: processKind ?? 'all', processes });
            }
            if (liveTail) {
                // La frise apprend le nouvel instant en même temps que les
                // graphes, sinon ses marques se figent à l'ouverture du panneau.
                const floor = point.timestamp - spanMs;
                const appendTs = (prev: number[]) =>
                    prev.length && point.timestamp <= prev[prev.length - 1]
                        ? prev
                        : [...prev, point.timestamp].filter((t) => t >= floor);
                setSnapshotTimes(appendTs);
                if (processes !== null) setProcTimes(appendTs);
                setPoints((prev) => {
                    if (prev.length && point.timestamp <= prev[prev.length - 1].timestamp) return prev;
                    // Rogné à la fenêtre affichée : un panneau laissé ouvert en
                    // direct accumulerait des points hors champ indéfiniment.
                    const floor = point.timestamp - spanMs;
                    const next = [...prev, point];
                    const from = next.findIndex((p) => p.timestamp >= floor);
                    return from <= 0 ? next : next.slice(from);
                });
            }
        });
        const offReport = onServerEvent(DEVICE_REPORT_EVENT, deviceReportPushSchema, (push) => {
            if (push.deviceId !== deviceId) return;
            setReport(push.report);
            setOverride((p) => ({ ...p, report: push.report }));
        });
        const offPresence = onServerEvent(DEVICE_PRESENCE_EVENT, devicePresenceSchema, (pres) => {
            if (pres.deviceId !== deviceId) return;
            setOverride((p) => ({ ...p, online: pres.online }));
            const seen = pres.lastSeen;
            if (seen) {
                setPresence((pr) => {
                    // Seules les vraies transitions entrent : la frise alterne
                    // ses segments, un doublon s'y lit comme un rayage. Le
                    // serveur horodate à la publication, d'où le plafond à
                    // l'instant courant.
                    const last = pr.events[pr.events.length - 1];
                    if (last && last.online === pres.online) return pr;
                    const ts = Math.min(seen * 1000, Date.now());
                    return { ...pr, events: [...pr.events, { ts, online: pres.online }] };
                });
            }
        });
        return () => {
            offMetrics();
            offReport();
            offPresence();
        };
        // `spanMs` en dépendance : la fermeture rogne à la fenêtre visible, et un
        // zoom élargi avec l'ancienne valeur retaillerait ce qu'on vient de lire.
    }, [deviceId, liveTail, spanMs]);

    // What a delete action would remove. Counted on the process instants only:
    // `devices.deleteSnapshots` leaves the metric rows alone, so an instant with
    // no process list has nothing to delete.
    const procSet = useMemo(() => new Set(procTimes), [procTimes]);
    const deleteTarget = useMemo(() => {
        if (focus.kind === 'snapshot') {
            if (!procSet.has(focus.at)) return null;
            return { kind: 'snapshot' as const, from: focus.at, to: focus.at, count: 1 };
        }
        if (focus.kind === 'range') {
            const count = procTimes.filter((t) => t >= focus.start && t <= focus.end).length;
            return { kind: 'range' as const, from: focus.start, to: focus.end, count };
        }
        return null;
    }, [focus, procTimes, procSet]);

    const pinnedSet = useMemo(() => new Set(pinnedTimes), [pinnedTimes]);

    // What a pin/unpin action targets: the bounds, how many snapshots fall
    // inside, how many are already pinned.
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
    // Fully pinned already: the action unpins.
    const allPinned = !!pinTarget && pinTarget.count > 0 && pinTarget.pinnedCount === pinTarget.count;

    const refreshSnapshotMarks = useCallback(() => {
        const id = idRef.current;
        api.send('devices.snapshots', { deviceId: id, from: windowRange.start, to: windowRange.end })
            .then((res) => {
                if (idRef.current === id) {
                    setSnapshotTimes(res.timestamps);
                    setPinnedTimes(res.pinned);
                    setProcTimes(res.withProcesses);
                    setTimelineTruncated(res.truncated);
                }
            })
            .catch(() => setReadError(true));
    }, [windowRange]);

    const refreshStorage = useCallback(() => {
        const id = idRef.current;
        api.send('devices.storage', { deviceId: id })
            .then((res) => {
                if (idRef.current === id)
                    setStorage({ snapshots: res.snapshots, processes: res.processes, bytes: res.bytes });
            })
            .catch(() => setReadError(true));
    }, []);

    const deleteSnapshots = useCallback(async () => {
        const id = idRef.current;
        if (!deleteTarget) return;
        setDeleting(true);
        try {
            await api.send('devices.deleteSnapshots', { deviceId: id, from: deleteTarget.from, to: deleteTarget.to });
            setDeleteOpen(false);
            setFocus({ kind: 'live' });
            refreshSnapshotMarks();
            refreshStorage();
            refreshAvailability();
        } catch {
            // Keep the dialog open: retryable.
        } finally {
            setDeleting(false);
        }
    }, [deleteTarget, refreshSnapshotMarks, refreshStorage, refreshAvailability]);

    // Unpinning may delete instants already past their deadline: drop to live.
    const setPinned = useCallback(
        async (pinned: boolean) => {
            const id = idRef.current;
            if (!pinTarget || pinning) return;
            setPinning(true);
            try {
                const res = await api.send('devices.setSnapshotsPinned', {
                    deviceId: id,
                    from: pinTarget.from,
                    to: pinTarget.to,
                    pinned
                });
                if (res.deletedSnapshots > 0) setFocus({ kind: 'live' });
                refreshSnapshotMarks();
                refreshStorage();
                refreshAvailability();
            } catch {
                // Retryable; leave the UI as-is.
            } finally {
                setPinning(false);
            }
        },
        [pinTarget, pinning, refreshSnapshotMarks, refreshStorage, refreshAvailability]
    );

    const refreshNow = useCallback(() => {
        const id = idRef.current;
        if (refreshing) return;
        setRefreshing(true);
        agent
            .send('agent.collect', { deviceId: id })
            .catch(() => setReadError(true))
            .finally(() => setTimeout(() => setRefreshing(false), 1200));
    }, [refreshing]);

    // Derived series for the graphs, mémoïsées ensemble : nues, elles se
    // recalculeraient à chaque rendu, soit à chaque relevé poussé.
    const { cpuS, ramS, diskS, netRx, netTx, diskRead, diskWrite, tempS, gpuS, batteryS } = useMemo(() => {
        const netRx: { t: number; v: number }[] = [];
        const netTx: { t: number; v: number }[] = [];
        for (let i = 1; i < points.length; i++) {
            const dt = (points[i].timestamp - points[i - 1].timestamp) / 1000;
            if (dt <= 0) continue;
            const t = points[i].timestamp;
            netRx.push({ t, v: Math.max(0, (points[i].netRxBytes - points[i - 1].netRxBytes) / dt) });
            netTx.push({ t, v: Math.max(0, (points[i].netTxBytes - points[i - 1].netTxBytes) / dt) });
        }
        // Disk I/O rates; skip the null gaps.
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
        return {
            cpuS: points.map((p) => ({ t: p.timestamp, v: p.cpuPercent })),
            ramS: points.map((p) => ({ t: p.timestamp, v: pct(p.memUsedBytes, p.memTotalBytes) })),
            diskS: points.map((p) => ({ t: p.timestamp, v: pct(p.diskUsedBytes, p.diskTotalBytes) })),
            netRx,
            netTx,
            diskRead,
            diskWrite,
            tempS: points.filter((p) => p.cpuTempC !== null).map((p) => ({ t: p.timestamp, v: p.cpuTempC as number })),
            gpuS: points
                .filter((p) => p.gpuPercent !== null)
                .map((p) => ({ t: p.timestamp, v: p.gpuPercent as number })),
            batteryS: points
                .filter((p) => p.batteryPercent !== null)
                .map((p) => ({ t: p.timestamp, v: p.batteryPercent as number }))
        };
    }, [points]);

    // Value to show in the KPI cards, per focus. En direct, uniquement le dernier
    // instant reçu : au-delà d'une heure de fenêtre les points sont des moyennes
    // horaires, et un instant n'est pas un seau.
    const display = useMemo<MetricSeriesPoint | null>(() => {
        if (focus.kind === 'range') return averageSnapshot(points);
        if (focus.kind === 'snapshot') return nearestBy(points, focus.at, (p) => p.timestamp);
        return liveSnapshot;
    }, [focus, points, liveSnapshot]);
    const averaged = focus.kind === 'range';

    // Bannière « hors ligne » seulement : la date du dernier instant reçu.
    const lastKnown = liveSnapshot;
    const online = selected?.online ?? false;
    const archived = selected?.status === 'archived';
    const pending = selected?.status === 'pending';
    const paused = (selected?.planPaused ?? false) && !archived;
    const cores = report?.os.cores ?? 0;
    const valuesMuted = !online && focus.kind === 'live';

    // The focus is the single driver here too (see features/devices/README.md §10).
    const procSample = focus.kind === 'live' ? liveProc : histProc;

    // Processus KPI, always rendered; `procStale` marks a value that isn't the
    // current live one, so the UI prefixes "~" and the hint gives its age.
    const procView = {
        count: display?.processCount ?? null,
        at: focus.kind === 'snapshot' ? focus.at : focus.kind === 'live' ? (procSample?.ts ?? null) : null,
        averaged: focus.kind === 'range'
    };

    // A per-process column only when at least one row has the data: these
    // probes are privilege- and platform-gated. Unknown is hidden, never 0.
    const procCols = useMemo(() => {
        const rows = procSample?.processes ?? [];
        return {
            disk: rows.some((p) => p.diskReadBytes !== null || p.diskWriteBytes !== null),
            conn: rows.some((p) => p.connIn !== null || p.connOut !== null),
            ports: rows.some((p) => p.listenPorts.length > 0)
        };
    }, [procSample]);

    // Grouped once so the header count and the sections can never disagree.
    const portGroups = useMemo(
        () => (report?.openPorts ? groupPorts(report.openPorts, report.hardware?.network ?? []) : null),
        [report]
    );

    // Every tick carries its process list: "stale" means the agent stopped reporting.
    const procStale =
        focus.kind === 'live' &&
        procView.count != null &&
        (!online || procView.at == null || Date.now() - procView.at > intervalMs * 2.5);
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

    // Graph definitions: a compact stat by default, full stats on click.
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
    // Aggregate stats + a per-disk breakdown from the latest report.
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

    /**
     * La liste ne varie jamais : chaque fonction y figure, et ce qui l'empêche
     * se lit sur elle. Le rôle d'abord, l'état de la machine ensuite (voir
     * `availability.ts`) — un appareil rallumé ne rendra pas une permission.
     */
    const reach = agentReach(selected);
    /**
     * L'agent annonce ce qu'il sait relever. Un agent en ligne dont le rapport
     * ne cite pas la sonde est trop ancien pour l'inventaire des conteneurs ;
     * hors ligne, il n'y a pas de rapport, et c'est `reach` qui parle en premier.
     */
    const noDockerProbe =
        online && report !== null && !(report.agent?.probes?.includes('docker') ?? false) ? OLD_AGENT : undefined;
    // Ce que la machine refuse chez elle. Lu dans son dernier rapport : sans
    // rapport, rien n'est présumé fermé, et l'agent refusera de toute façon.
    const policy = report?.agent?.policy;
    const refusedLocally = (order: keyof AgentPolicy): Unavailable | undefined =>
        policy && !policy[order] ? LOCAL_POLICY : undefined;
    const remote = (
        key: string,
        label: string,
        onClick: () => void,
        icon: string,
        order?: keyof AgentPolicy
    ): DeviceAction => ({
        icon,
        label,
        onClick,
        unavailable: firstReason(
            permissions.canExtra('devices', key, selected.id) ? undefined : missingPermission(key),
            reach,
            order && refusedLocally(order)
        )
    });

    const deviceActions: DeviceAction[] = [
        // Le seul geste qui ne dépend de rien : il relit le dernier rapport reçu.
        { icon: 'icon-cpu', label: 'Matériel', onClick: showHardwareInfo },
        remote('files', 'Explorateur de fichiers', () => setFilesOpen(true), 'icon-folder'),
        remote('terminal', 'Terminal distant', () => setTerminalOpen(true), 'icon-terminal', 'terminal'),
        remote('logs', 'Logs de l’appareil', () => setLogsOpen(true), 'icon-logs'),
        {
            icon: 'icon-server',
            label: 'Conteneurs Docker',
            onClick: () => setDockerOpen(true),
            unavailable: firstReason(
                permissions.canExtra('devices', 'docker', selected.id) ? undefined : missingPermission('docker'),
                reach,
                noDockerProbe
            )
        },
        remote('system', 'Commandes système', () => setPowerOpen(true), 'icon-power', 'power'),
        remote('system', 'Mises à jour système', () => setPackagesOpen(true), 'icon-database', 'pkgUpgrade'),
        // Ce que l'agent est et ce qui se fait sur lui. La popup se lit même hors
        // ligne : chacun de ses gestes dit ce qui l'empêche.
        { icon: 'icon-wrench', label: 'Agent', onClick: () => setAgentOpen(true) },
        // La fiche ferme la liste : renommer, supprimer, sous le droit
        // d'écriture de l'espace.
        ...deviceLifecycleActions(selected, actions, canWrite)
    ];

    return (
        <div className={styles.metricsPanel}>
            <div className={styles.metricsPanelHeader}>
                <h3>{selected.name}</h3>
                <div className={styles.headerRight}>
                    {/* L'état de l'appareil ouvre la rangée : on le lit avant
                        de choisir quoi faire de la machine. */}
                    {report?.agent?.insecureTransport && (
                        <span
                            className={`${styles.onlineBadge} ${styles.offline}`}
                            title='Cet agent joint le serveur en http : son jeton et tout ce qu’il reçoit, terminal compris, circulent en clair'
                        >
                            Transport non chiffré
                        </span>
                    )}
                    {archived ? (
                        <span className={`${styles.onlineBadge} ${styles.archived}`}>Archivé</span>
                    ) : pending ? (
                        <span className={`${styles.onlineBadge} ${styles.awaiting}`}>En attente d’approbation</span>
                    ) : (
                        <span className={`${styles.onlineBadge} ${online ? styles.online : styles.offline}`}>
                            {online ? 'En ligne' : 'Hors ligne'}
                        </span>
                    )}
                    {paused && <PlanPausedBadge />}
                    {online && !archived && canWrite && agentUpdatable(selected) && (
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
                    <DeviceActionsMenu actions={deviceActions} />
                    {/* En dernier, comme partout : les réglages de CET appareil. */}
                    <FeatureSettingsButton
                        scope={{ kind: 'item', feature: 'devices', itemId: selected.id, itemLabel: selected.name }}
                    />
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

            {paused ? (
                <div className={styles.offlineBanner}>
                    <span className='icon icon-pause' />
                    En pause : l’appareil dépasse la limite de l’offre, son agent n’est plus accepté et rien n’est
                    relevé. Rien n’est supprimé, et il reprend dans les minutes qui suivent, dès que l’offre le permet.
                </div>
            ) : pending ? (
                <div className={styles.offlineBanner}>
                    <span className='icon icon-clock' />
                    En attente d’approbation : cette machine a été reliée à nouveau, son agent n’est pas admis tant que
                    personne ne l’a approuvée (popup « Agent »).
                </div>
            ) : (
                !online && (
                    <div className={styles.offlineBanner}>
                        <span className='icon icon-clock' />
                        Hors ligne
                        {selected.lastSeen ? ` depuis ${formatAgo(selected.lastSeen * 1000)}` : ''}
                        {lastKnown
                            ? ` · dernières données le ${new Date(lastKnown.timestamp).toLocaleString('fr-FR')}`
                            : ''}
                    </div>
                )
            )}

            {readError && (
                <div className={styles.offlineBanner}>
                    <span className='icon icon-x-circle' />
                    Certaines données n’ont pas pu être chargées. Les cartes vides ne signifient pas forcément une
                    absence de relevés.
                </div>
            )}

            {timelineTruncated && (
                <div className={styles.offlineBanner}>
                    <span className='icon icon-info' />
                    Trop de relevés sur cette période : la frise n’affiche que les plus récents. Réduisez la fenêtre
                    pour tous les parcourir.
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
                processTimes={procTimes}
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
                days={dataDays}
                spanMs={spanMs}
                zoomPresets={ZOOM_PRESETS}
                onSpanChange={setSpanMs}
            />

            {/* Snapshot footprint + keep/delete: these actions target the whole
                focused snapshot/zone. */}
            <div className={styles.snapshotBar}>
                <span className={styles.snapshotUsage} title='Espace occupé en base par les snapshots de cet appareil'>
                    <span className='icon icon-server' />
                    {storage
                        ? `${storage.snapshots} instant${storage.snapshots > 1 ? 's' : ''} · ${storage.processes.toLocaleString('fr-FR')} processus · ≈ ${formatBytesFr(storage.bytes)} en base`
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

            {/* Graphs */}
            <div className={styles.graphsSpan} title='Durée couverte par les graphiques'>
                <span className='icon icon-clock' />
                <span>{formatDuration(graphWindow.end - graphWindow.start)}</span>
            </div>
            {/* Une plage sans relevé : on l'énonce, plutôt qu'une grille de
                cartes grises et muettes. */}
            {metricsReady && points.length === 0 ? (
                <p className={styles.waitingMsg}>
                    Aucun relevé sur cette période
                    {focus.kind === 'range' || focus.kind === 'snapshot'
                        ? ' — sélectionnez une autre plage ou revenez au direct.'
                        : '.'}
                </p>
            ) : null}
            <div className={styles.graphsGrid}>
                {metricsReady
                    ? points.length === 0
                        ? null
                        : shownGraphs.map((g) => g.node)
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
            {metricsReady && points.length > 0 && allGraphs.length > COLLAPSED_GRAPHS && (
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
                                    ? 'Aucun relevé de processus pour le moment'
                                    : procView.at != null
                                      ? `Nombre total de processus · relevé ${ageLabel(procView.at)}`
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

            {/* Open listening ports, grouped by reachability then interface */}
            <div className={styles.section}>
                <h4 className={styles.sectionTitle}>
                    Ports en écoute
                    {portGroups && portGroups.length > 0 && (
                        <span className={styles.sectionMeta}>
                            {portGroups.length} port{portGroups.length > 1 ? 's' : ''}
                        </span>
                    )}
                </h4>
                {report ? (
                    <OpenPorts groups={portGroups} privileged={report.agent?.privileged ?? false} />
                ) : (
                    <p className={styles.waitingMsg}>Aucun bilan.</p>
                )}
            </div>

            {/* Processes at the selected moment */}
            <div className={styles.section}>
                <h4 className={styles.sectionTitle}>
                    Processus les plus actifs
                    {procSample && (
                        <span
                            className={styles.sectionMeta}
                            title={`Relevé du ${new Date(procSample.ts).toLocaleString('fr-FR')} — le même instant que les graphes`}
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
                                    {procCols.disk && (
                                        <th className={styles.procNum} title='Octets lus / écrits depuis le démarrage'>
                                            Disque
                                        </th>
                                    )}
                                    {procCols.conn && (
                                        <th
                                            className={styles.procNum}
                                            title='Connexions établies entrantes / sortantes'
                                        >
                                            Conn.
                                        </th>
                                    )}
                                    {procCols.ports && <th className={styles.procNum}>Ports</th>}
                                </tr>
                            </thead>
                            <tbody>
                                {procSample.processes.slice(0, showAllProcs ? undefined : 12).map((p, i) => {
                                    const cpuNorm = cores > 0 ? Math.min(100, p.cpuPercent / cores) : p.cpuPercent;
                                    return (
                                        <tr key={`${p.name}-${i}`} title={processTitle(p)}>
                                            <td className={styles.procName}>
                                                {p.name}
                                                {p.instances > 1 && (
                                                    <span className={styles.procInstances}>×{p.instances}</span>
                                                )}
                                            </td>
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
                                            {procCols.disk && (
                                                <td className={styles.procNum}>
                                                    {p.diskReadBytes === null || p.diskWriteBytes === null
                                                        ? '—'
                                                        : `${formatBytes(p.diskReadBytes)} / ${formatBytes(p.diskWriteBytes)}`}
                                                </td>
                                            )}
                                            {procCols.conn && (
                                                <td className={styles.procNum}>
                                                    {p.connIn === null && p.connOut === null
                                                        ? '—'
                                                        : `${p.connIn ?? 0} ↓ / ${p.connOut ?? 0} ↑`}
                                                </td>
                                            )}
                                            {procCols.ports && (
                                                <td
                                                    className={`${styles.procNum} ${styles.procPorts}`}
                                                    title={
                                                        p.listenPorts.length > 0 ? p.listenPorts.join(', ') : undefined
                                                    }
                                                >
                                                    {p.listenPorts.length > 0 ? p.listenPorts.join(', ') : '—'}
                                                </td>
                                            )}
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
                            ? 'Pas encore de relevé de processus.'
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

            <Dialog
                open={packagesOpen}
                onClose={() => setPackagesOpen(false)}
                title={`Mises à jour — « ${selected.name} »`}
                description='Gestionnaires détectés sur l’appareil et application des mises à jour en direct.'
            >
                {packagesOpen && (
                    <PackagesPanel deviceId={selected.id} privileged={report?.agent?.privileged ?? null} />
                )}
            </Dialog>

            <Dialog
                open={powerOpen}
                onClose={() => setPowerOpen(false)}
                title={`Commandes système — « ${selected.name} »`}
                description='Actions exécutées sur l’appareil par l’agent (selon ses privilèges et l’OS).'
            >
                {powerOpen && <PowerMenu deviceId={selected.id} />}
            </Dialog>

            <Dialog
                open={agentOpen}
                onClose={() => setAgentOpen(false)}
                title={`Agent — « ${selected.name} »`}
                description='L’agent DevEye installé sur l’appareil : son état, sa persistance, ses privilèges et son accès.'
                width={620}
            >
                {agentOpen && (
                    <AgentPanel
                        device={selected}
                        report={report}
                        actions={actions}
                        canWrite={canWrite}
                        updater={updater}
                        onShowPrivilegeInfo={showPrivilegeInfo}
                    />
                )}
            </Dialog>

            <Dialog
                open={logsOpen}
                onClose={() => setLogsOpen(false)}
                title={`Logs — « ${selected.name} »`}
                description='Journal système, conteneurs Docker et fichiers de logs de l’appareil, avec recherche avancée.'
                width={860}
            >
                {logsOpen && <LogsPanel deviceId={selected.id} />}
            </Dialog>

            <Dialog
                open={dockerOpen}
                onClose={() => setDockerOpen(false)}
                title={`Conteneurs — « ${selected.name} »`}
                description='Conteneurs, images, volumes et réseaux de l’appareil : état, ressources et gestion.'
                width={920}
            >
                {dockerOpen && (
                    <Suspense fallback={<p className={styles.waitingMsg}>Chargement des conteneurs…</p>}>
                        <DockerPanel deviceId={selected.id} />
                    </Suspense>
                )}
            </Dialog>

            <Dialog
                open={terminalOpen}
                onClose={() => setTerminalOpen(false)}
                title={`Terminal — « ${selected.name} »`}
                description='Shell interactif distant. Compte et comportement configurables via ⚙.'
                width={900}
            >
                {terminalOpen && (
                    <Suspense fallback={<p className={styles.waitingMsg}>Chargement du terminal…</p>}>
                        <TerminalPanel deviceId={selected.id} onClose={() => setTerminalOpen(false)} />
                    </Suspense>
                )}
            </Dialog>

            <Dialog
                open={filesOpen}
                onClose={() => setFilesOpen(false)}
                title={`Fichiers — « ${selected.name} »`}
                description='Explorateur de fichiers : navigation, analyse d’espace disque, recherche avancée et nettoyage.'
                width={920}
            >
                {filesOpen && (
                    <Suspense fallback={<p className={styles.waitingMsg}>Chargement de l’explorateur…</p>}>
                        <FilesPanel deviceId={selected.id} writable={policy?.filesWrite ?? true} />
                    </Suspense>
                )}
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

            <DeviceDialogs actions={actions} device={selected} />
            {actions.actionError && <p className={styles.waitingMsg}>{actions.actionError}</p>}
        </div>
    );
}
