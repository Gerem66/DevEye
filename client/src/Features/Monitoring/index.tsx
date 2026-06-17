import { useCallback, useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { ws } from '@/api/ws';
import {
    DEVICE_PRESENCE_EVENT,
    METRICS_PUSH_EVENT,
    type Device,
    type DevicePresence,
    type MetricSnapshot,
    type MetricsPush
} from 'deveye-types';
import type { FeatureProps } from '../types';
import { useFeatureLifecycle } from '../useFeatureLifecycle';
import styles from './Monitoring.module.css';

const HISTORY_SIZE = 30;

function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
    return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
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

interface SparklineProps {
    data: number[];
    className?: string;
}

function Sparkline({ data, className }: SparklineProps) {
    if (data.length < 2) return null;
    const W = 200;
    const H = 36;
    const pts = data
        .map((v, i) => {
            const x = (i / (data.length - 1)) * W;
            const y = H - Math.max(0, Math.min(1, v / 100)) * H;
            return `${x.toFixed(1)},${y.toFixed(1)}`;
        })
        .join(' ');
    return (
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio='none' className={className}>
            <polyline points={pts} fill='none' stroke='var(--accent)' strokeWidth='1.5' strokeLinejoin='round' />
        </svg>
    );
}

// ─── Widget compact ───────────────────────────────────────────────────────────

export function MonitoringWidget() {
    const [devices, setDevices] = useState<Device[]>([]);

    useEffect(() => {
        ws.send('device.list', {})
            .then((res) => setDevices(res.devices))
            .catch(() => {});
    }, []);

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
    const [devices, setDevices] = useState<Device[]>([]);
    const [loading, setLoading] = useState(true);
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [snapshot, setSnapshot] = useState<MetricSnapshot | null>(null);
    const [cpuHistory, setCpuHistory] = useState<number[]>([]);
    const prevSelectedId = useRef<string | null>(null);

    // Initial device list
    const fetchDevices = useCallback(async () => {
        try {
            const res = await ws.send('device.list', {});
            setDevices(res.devices);
            if (res.devices.length > 0 && prevSelectedId.current === null) {
                setSelectedId(res.devices[0].id);
            }
        } catch {
            // ignore
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        void fetchDevices();
    }, [fetchDevices]);

    // Subscribe on device selection; unsubscribe from the previous one.
    // The teardown when the feature itself is unloaded is handled once in
    // useFeatureLifecycle below (so the live subscription stops when the cache
    // expires / is reset), avoiding a double unsubscribe here.
    useEffect(() => {
        const prev = prevSelectedId.current;
        prevSelectedId.current = selectedId;

        if (prev && prev !== selectedId) {
            ws.send('metrics.unsubscribe', { deviceIds: [prev] }).catch(() => {});
        }
        if (!selectedId) return;

        setSnapshot(null);
        setCpuHistory([]);
        ws.send('metrics.subscribe', { deviceIds: [selectedId] }).catch(() => {});
    }, [selectedId]);

    // Feature unloaded (cache TTL expiry, Ctrl+click reset, or leaving the
    // dashboard) — drop the live metrics subscription cleanly. Note: while the
    // feature is merely closed-but-cached it stays subscribed so reopening is
    // instant; the subscription only stops when the instance is truly unloaded.
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
                if (push.deviceId === selectedId) {
                    setSnapshot(push.snapshot);
                    setCpuHistory((prev) => [...prev.slice(-(HISTORY_SIZE - 1)), push.snapshot.cpuPercent]);
                }
            }
            if (msg.command === DEVICE_PRESENCE_EVENT && msg.payload.ok) {
                const pres = msg.payload.data as DevicePresence;
                setDevices((prev) => prev.map((d) => (d.id === pres.deviceId ? { ...d, online: pres.online } : d)));
            }
        });
        return off;
    }, [selectedId]);

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
                    <p className={styles.hint}>Liez un agent depuis l&apos;onglet &quot;Appareils&quot;.</p>
                </div>
            ) : (
                <div className={styles.grid}>
                    {/* Left: device list */}
                    <div className={styles.deviceListFull}>
                        {devices.map((d) => (
                            <motion.button
                                key={d.id}
                                className={`${styles.deviceCard} ${d.id === selectedId ? styles.selected : ''}`}
                                onClick={() => setSelectedId(d.id)}
                                whileHover={{ scale: 1.02 }}
                                whileTap={{ scale: 0.98 }}
                            >
                                <div className={`${styles.statusDot} ${d.online ? styles.online : styles.offline}`} />
                                <div className={styles.deviceCardInfo}>
                                    <span className={styles.deviceCardName}>{d.name}</span>
                                    <span className={styles.deviceCardPlatform}>{d.platform}</span>
                                </div>
                            </motion.button>
                        ))}
                    </div>

                    {/* Right: metrics panel */}
                    {selected && (
                        <div className={styles.metricsPanel}>
                            <div className={styles.metricsPanelHeader}>
                                <h3>{selected.name}</h3>
                                <span
                                    className={`${styles.onlineBadge} ${selected.online ? styles.online : styles.offline}`}
                                >
                                    {selected.online ? 'En ligne' : 'Hors ligne'}
                                </span>
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
                                        <Sparkline data={cpuHistory} className={styles.sparkline} />
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

                                    <div className={styles.infoRow}>
                                        <div className={styles.infoCard}>
                                            <span className={styles.infoLabel}>Réseau ↓</span>
                                            <span className={styles.infoVal}>{formatBytes(snapshot.netRxBytes)}</span>
                                        </div>
                                        <div className={styles.infoCard}>
                                            <span className={styles.infoLabel}>Réseau ↑</span>
                                            <span className={styles.infoVal}>{formatBytes(snapshot.netTxBytes)}</span>
                                        </div>
                                        <div className={styles.infoCard}>
                                            <span className={styles.infoLabel}>Utilisateurs</span>
                                            <span className={styles.infoVal}>{snapshot.usersCount}</span>
                                        </div>
                                    </div>
                                </>
                            )}

                            <div className={styles.deviceMeta}>
                                <span>Plateforme : {selected.platform}</span>
                                <span>Statut : {selected.status}</span>
                            </div>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
