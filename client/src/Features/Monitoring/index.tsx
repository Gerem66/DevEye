import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { ws } from '@/api/ws';
import { useDevices } from '@/stores/devices';
import {
    DEVICE_PRESENCE_EVENT,
    DEVICE_REPORT_EVENT,
    METRICS_PUSH_EVENT,
    type DevicePresence,
    type DeviceReport,
    type DeviceReportPush,
    type MetricSnapshot,
    type MetricsPush
} from 'deveye-types';
import type { FeatureProps } from '../types';
import { useFeatureLifecycle } from '../useFeatureLifecycle';
import styles from './Monitoring.module.css';

const HISTORY_SIZE = 30;
/** Recent window (ms) backfilled on selection so graphs aren't empty. */
const BACKFILL_MS = 5 * 60 * 1000;

function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
    return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function formatRate(bytesPerSec: number): string {
    return `${formatBytes(Math.max(0, Math.round(bytesPerSec)))}/s`;
}

function formatUptime(seconds: number): string {
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    if (d > 0) return `${d}j ${h}h`;
    if (h > 0) return `${h}h ${m}min`;
    return `${m}min`;
}

function barColor(pct: number): string {
    if (pct >= 85) return 'var(--danger)';
    if (pct >= 60) return 'var(--warning)';
    return 'var(--accent)';
}

interface MetricBarProps {
    label: string;
    pct: number;
    valueLabel: string;
}

function MetricBar({ label, pct, valueLabel }: MetricBarProps) {
    return (
        <div className={styles.metricRow}>
            <div className={styles.metricHeader}>
                <span className={styles.metricLabel}>{label}</span>
                <span className={styles.metricValue}>{valueLabel}</span>
            </div>
            <div className={styles.barTrack}>
                <motion.div
                    className={styles.barFill}
                    style={{ backgroundColor: barColor(pct) }}
                    animate={{ width: `${pct}%` }}
                    transition={{ duration: 0.4, ease: 'easeOut' }}
                />
            </div>
        </div>
    );
}

/** A CPU history point: value `v` (%) at unix-ms time `t`. */
interface HistoryPoint {
    t: number;
    v: number;
}

interface SparklineProps {
    points: HistoryPoint[];
    className?: string;
}

/**
 * Time-aware sparkline: the x-axis is the real timestamp span, so irregular
 * gaps (a manual refresh between periodic samples, a reconnection) are drawn to
 * scale instead of evenly spaced.
 */
function Sparkline({ points, className }: SparklineProps) {
    if (points.length < 2) return null;
    const W = 200;
    const H = 36;
    const tMin = points[0].t;
    const span = Math.max(1, points[points.length - 1].t - tMin);
    const pts = points
        .map((p) => {
            const x = ((p.t - tMin) / span) * W;
            const y = H - Math.max(0, Math.min(1, p.v / 100)) * H;
            return `${x.toFixed(1)},${y.toFixed(1)}`;
        })
        .join(' ');
    return (
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio='none' className={className}>
            <polyline points={pts} fill='none' stroke='var(--accent)' strokeWidth='1.5' strokeLinejoin='round' />
        </svg>
    );
}

/** A small "label: value" info card with an optional emphasis tone. */
function InfoCard({ label, value }: { label: string; value: string }) {
    return (
        <div className={styles.infoCard}>
            <span className={styles.infoLabel}>{label}</span>
            <span className={styles.infoVal}>{value}</span>
        </div>
    );
}

/** Security posture chip. `value === null` renders an "unknown" neutral state. */
function SecurityChip({
    label,
    value,
    goodWhenTrue = true
}: {
    label: string;
    value: boolean | null;
    goodWhenTrue?: boolean;
}) {
    let tone = styles.secUnknown;
    let text = 'Inconnu';
    if (value !== null) {
        const good = goodWhenTrue ? value : !value;
        tone = good ? styles.secGood : styles.secBad;
        text = value ? 'Oui' : 'Non';
    }
    return (
        <div className={`${styles.secChip} ${tone}`}>
            <span className={styles.secLabel}>{label}</span>
            <span className={styles.secVal}>{text}</span>
        </div>
    );
}

// ─── Widget compact ───────────────────────────────────────────────────────────

export function MonitoringWidget() {
    // Shared store: auto-polls device.list, so newly paired devices and their
    // online state appear here without a manual refresh.
    const { devices } = useDevices();

    const onlineCount = devices.filter((d) => d.online).length;

    return (
        <div className={styles.widgetContent}>
            <div className={styles.stat}>
                <span className={styles.statValue}>{onlineCount}</span>
                <span className={styles.statLabel}>en ligne</span>
            </div>
            <div className={styles.deviceList}>
                {devices.slice(0, 3).map((d) => (
                    <div key={d.id} className={`${styles.deviceItem} ${d.online ? styles.online : styles.offline}`}>
                        <div className={`${styles.miniDot} ${d.online ? styles.online : styles.offline}`} />
                        <span className={styles.deviceName}>{d.name}</span>
                    </div>
                ))}
                {devices.length > 3 && <span className={styles.moreDevices}>+{devices.length - 3} autres</span>}
            </div>
        </div>
    );
}

// ─── Full view ────────────────────────────────────────────────────────────────

export default function Monitoring({ user: _user, workspace: _ws }: FeatureProps) {
    // Device list comes from the shared store (auto-polling), so a freshly
    // paired/approved device shows up here on its own. Live push events
    // (presence/report) are layered on top via `overrides` for instant feedback.
    const { devices: baseDevices, loading } = useDevices();
    const [overrides, setOverrides] = useState<Record<string, { online?: boolean; report?: DeviceReport | null }>>({});
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [snapshot, setSnapshot] = useState<MetricSnapshot | null>(null);
    const [report, setReport] = useState<DeviceReport | null>(null);
    const [cpuHistory, setCpuHistory] = useState<HistoryPoint[]>([]);
    const [netRate, setNetRate] = useState<{ rx: number; tx: number }>({ rx: 0, tx: 0 });
    const [refreshing, setRefreshing] = useState(false);
    const prevSelectedId = useRef<string | null>(null);
    // Previous snapshot for the selected device, used to derive network rates.
    const prevSnapshot = useRef<MetricSnapshot | null>(null);

    const devices = useMemo(
        () => baseDevices.map((d) => (overrides[d.id] ? { ...d, ...overrides[d.id] } : d)),
        [baseDevices, overrides]
    );
    // Latest devices, read inside the selection effect without making it a dep
    // (otherwise every 6s poll would re-subscribe).
    const devicesRef = useRef(devices);
    devicesRef.current = devices;

    // Auto-select the first device once the list is available.
    useEffect(() => {
        if (selectedId === null && baseDevices.length > 0) setSelectedId(baseDevices[0].id);
    }, [baseDevices, selectedId]);

    // Apply a freshly received snapshot. Snapshots are keyed by their real
    // timestamp: out-of-order or duplicate samples (the subscribe backfill and
    // the initial push can overlap) are ignored, so history stays monotonic and
    // both periodic and manual-refresh samples land at their true time.
    const applySnapshot = useCallback((snap: MetricSnapshot) => {
        const prev = prevSnapshot.current;
        if (prev && snap.timestamp <= prev.timestamp) return;
        setSnapshot(snap);
        setCpuHistory((h) => [...h.slice(-(HISTORY_SIZE - 1)), { t: snap.timestamp, v: snap.cpuPercent }]);
        if (prev) {
            const dt = (snap.timestamp - prev.timestamp) / 1000;
            if (dt > 0) {
                setNetRate({
                    rx: Math.max(0, (snap.netRxBytes - prev.netRxBytes) / dt),
                    tx: Math.max(0, (snap.netTxBytes - prev.netTxBytes) / dt)
                });
            }
        }
        prevSnapshot.current = snap;
    }, []);

    // Ask the agent to push fresh data right now.
    const refreshNow = useCallback(() => {
        const id = prevSelectedId.current;
        if (!id || refreshing) return;
        setRefreshing(true);
        ws.send('metrics.refresh', { deviceId: id })
            .catch(() => {})
            .finally(() => setTimeout(() => setRefreshing(false), 1200));
    }, [refreshing]);

    // Subscribe on device selection; unsubscribe from the previous one. The
    // server pushes the latest stored snapshot + report right after subscribe,
    // and we also backfill recent history via metrics.query so graphs aren't
    // empty. Teardown on feature unload is handled in useFeatureLifecycle below.
    useEffect(() => {
        const prev = prevSelectedId.current;
        prevSelectedId.current = selectedId;

        if (prev && prev !== selectedId) {
            ws.send('metrics.unsubscribe', { deviceIds: [prev] }).catch(() => {});
        }
        if (!selectedId) return;

        setSnapshot(null);
        setReport(devicesRef.current.find((d) => d.id === selectedId)?.report ?? null);
        setCpuHistory([]);
        setNetRate({ rx: 0, tx: 0 });
        prevSnapshot.current = null;

        const id = selectedId;
        // Backfill recent history (best-effort).
        const now = Date.now();
        ws.send('metrics.query', { deviceId: id, from: now - BACKFILL_MS, to: now, resolution: 'raw' })
            .then((res) => {
                if (prevSelectedId.current !== id || res.points.length === 0) return;
                setCpuHistory(res.points.slice(-HISTORY_SIZE).map((p) => ({ t: p.timestamp, v: p.cpuPercent })));
                const last = res.points[res.points.length - 1];
                prevSnapshot.current = last;
                setSnapshot(last);
            })
            .catch(() => {});

        ws.send('metrics.subscribe', { deviceIds: [id] }).catch(() => {});
    }, [selectedId]);

    useFeatureLifecycle({
        onUnmount: () => {
            const active = prevSelectedId.current;
            if (active) ws.send('metrics.unsubscribe', { deviceIds: [active] }).catch(() => {});
        }
    });

    // Listen for push events
    useEffect(() => {
        const off = ws.onMessage((msg) => {
            if (msg.command === METRICS_PUSH_EVENT && msg.payload.ok) {
                const push = msg.payload.data as MetricsPush;
                if (push.deviceId === selectedId) applySnapshot(push.snapshot);
            }
            if (msg.command === DEVICE_REPORT_EVENT && msg.payload.ok) {
                const push = msg.payload.data as DeviceReportPush;
                if (push.deviceId === selectedId) setReport(push.report);
                setOverrides((prev) => ({ ...prev, [push.deviceId]: { ...prev[push.deviceId], report: push.report } }));
            }
            if (msg.command === DEVICE_PRESENCE_EVENT && msg.payload.ok) {
                const pres = msg.payload.data as DevicePresence;
                setOverrides((prev) => ({ ...prev, [pres.deviceId]: { ...prev[pres.deviceId], online: pres.online } }));
            }
        });
        return off;
    }, [selectedId, applySnapshot]);

    const selected = devices.find((d) => d.id === selectedId) ?? null;

    const cpuPct = snapshot?.cpuPercent ?? 0;
    const ramPct = snapshot ? (snapshot.memUsedBytes / snapshot.memTotalBytes) * 100 : 0;
    const diskPct = snapshot ? (snapshot.diskUsedBytes / snapshot.diskTotalBytes) * 100 : 0;

    return (
        <div className={styles.container}>
            <h2 className={styles.title}>Monitoring</h2>
            <p className={styles.subtitle}>Surveillance en temps réel de vos appareils</p>

            {loading ? (
                <div className={styles.loader}>Chargement...</div>
            ) : devices.length === 0 ? (
                <div className={styles.empty}>
                    <span className={`icon icon-server ${styles.emptyIcon}`} />
                    <p>Aucun appareil configuré</p>
                    <p className={styles.hint}>Liez un agent depuis le menu « Appareils » (en haut à droite).</p>
                </div>
            ) : (
                <div className={styles.grid}>
                    {/* Left: device list. No scale-on-hover here — the panel clips
                        its overflow, which cropped a scaled card's left edge. */}
                    <div className={styles.deviceListFull}>
                        {devices.map((d) => (
                            <button
                                key={d.id}
                                className={`${styles.deviceCard} ${d.id === selectedId ? styles.selected : ''}`}
                                onClick={() => setSelectedId(d.id)}
                            >
                                <div className={`${styles.statusDot} ${d.online ? styles.online : styles.offline}`} />
                                <div className={styles.deviceCardInfo}>
                                    <span className={styles.deviceCardName}>{d.name}</span>
                                    <span className={styles.deviceCardPlatform}>{d.platform}</span>
                                </div>
                            </button>
                        ))}
                    </div>

                    {/* Right: metrics panel */}
                    {selected && (
                        <div className={styles.metricsPanel}>
                            <div className={styles.metricsPanelHeader}>
                                <h3>{selected.name}</h3>
                                <div className={styles.headerRight}>
                                    {selected.online && (
                                        <button
                                            className={styles.refreshBtn}
                                            onClick={refreshNow}
                                            disabled={refreshing}
                                            title='Rafraîchir maintenant'
                                            aria-label='Rafraîchir maintenant'
                                        >
                                            <span
                                                className={`icon icon-refresh ${refreshing ? styles.spinning : ''}`}
                                            />
                                        </button>
                                    )}
                                    <span
                                        className={`${styles.onlineBadge} ${selected.online ? styles.online : styles.offline}`}
                                    >
                                        {selected.online ? 'En ligne' : 'Hors ligne'}
                                    </span>
                                </div>
                            </div>

                            {!selected.online ? (
                                <p className={styles.offlineMsg}>Appareil hors ligne — métriques indisponibles.</p>
                            ) : !snapshot ? (
                                <p className={styles.waitingMsg}>En attente du premier snapshot…</p>
                            ) : (
                                <>
                                    {/* CPU with sparkline */}
                                    <div className={styles.cpuSection}>
                                        <MetricBar label='CPU' pct={cpuPct} valueLabel={`${cpuPct.toFixed(1)}%`} />
                                        <Sparkline points={cpuHistory} className={styles.sparkline} />
                                    </div>

                                    <MetricBar
                                        label='RAM'
                                        pct={ramPct}
                                        valueLabel={`${formatBytes(snapshot.memUsedBytes)} / ${formatBytes(snapshot.memTotalBytes)}`}
                                    />
                                    <MetricBar
                                        label='Disque'
                                        pct={diskPct}
                                        valueLabel={`${formatBytes(snapshot.diskUsedBytes)} / ${formatBytes(snapshot.diskTotalBytes)}`}
                                    />

                                    <div className={styles.infoGrid}>
                                        <InfoCard label='Réseau ↓' value={formatRate(netRate.rx)} />
                                        <InfoCard label='Réseau ↑' value={formatRate(netRate.tx)} />
                                        <InfoCard label='Utilisateurs' value={String(snapshot.usersCount)} />
                                        {snapshot.cpuTempC !== null && (
                                            <InfoCard label='Température' value={`${snapshot.cpuTempC.toFixed(1)}°C`} />
                                        )}
                                        {snapshot.loadAvg1 !== null && (
                                            <InfoCard label='Charge (1m)' value={snapshot.loadAvg1.toFixed(2)} />
                                        )}
                                        {snapshot.processCount !== null && (
                                            <InfoCard label='Processus' value={String(snapshot.processCount)} />
                                        )}
                                        {snapshot.activeConnections !== null && (
                                            <InfoCard label='Connexions' value={String(snapshot.activeConnections)} />
                                        )}
                                        {snapshot.uptimeSeconds !== null && (
                                            <InfoCard label='Uptime' value={formatUptime(snapshot.uptimeSeconds)} />
                                        )}
                                    </div>

                                    {/* Security posture */}
                                    <div className={styles.section}>
                                        <h4 className={styles.sectionTitle}>Sécurité</h4>
                                        {report ? (
                                            <div className={styles.secGrid}>
                                                <SecurityChip label='Pare-feu' value={report.security.firewall} />
                                                <SecurityChip
                                                    label='Chiffrement disque'
                                                    value={report.security.diskEncryption}
                                                />
                                                {selected.platform === 'macos' && (
                                                    <SecurityChip label='SIP' value={report.security.sip} />
                                                )}
                                                {report.security.pendingUpdates !== null && (
                                                    <div
                                                        className={`${styles.secChip} ${report.security.pendingUpdates > 0 ? styles.secWarn : styles.secGood}`}
                                                    >
                                                        <span className={styles.secLabel}>MAJ en attente</span>
                                                        <span className={styles.secVal}>
                                                            {report.security.pendingUpdates}
                                                        </span>
                                                    </div>
                                                )}
                                            </div>
                                        ) : (
                                            <p className={styles.waitingMsg}>En attente du bilan de sécurité…</p>
                                        )}
                                    </div>

                                    {/* Top processes */}
                                    {report && report.topProcesses.length > 0 && (
                                        <div className={styles.section}>
                                            <h4 className={styles.sectionTitle}>Processus les plus actifs</h4>
                                            <table className={styles.procTable}>
                                                <thead>
                                                    <tr>
                                                        <th>Nom</th>
                                                        <th className={styles.procNum}>CPU</th>
                                                        <th className={styles.procNum}>Mémoire</th>
                                                    </tr>
                                                </thead>
                                                <tbody>
                                                    {report.topProcesses.map((p, i) => (
                                                        <tr key={`${p.name}-${i}`}>
                                                            <td className={styles.procName}>{p.name}</td>
                                                            <td className={styles.procNum}>
                                                                {p.cpuPercent.toFixed(1)}%
                                                            </td>
                                                            <td className={styles.procNum}>
                                                                {formatBytes(p.memBytes)}
                                                            </td>
                                                        </tr>
                                                    ))}
                                                </tbody>
                                            </table>
                                        </div>
                                    )}
                                </>
                            )}

                            <div className={styles.deviceMeta}>
                                {report && (
                                    <span>
                                        OS : {report.os.name} {report.os.version} ({report.os.arch})
                                    </span>
                                )}
                                <span>Plateforme : {selected.platform}</span>
                            </div>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
