import { useCallback, useEffect, useState } from 'react';
import type { AllowScope, DevicePosture, DeviceSentinelState, Finding, FindingSeverity } from 'deveye-types';

import { ws } from '@/api/ws';
import { onResourceChange } from '@/stores/invalidation';
import { refreshSentinel } from '@/stores/sentinel';

import BaselinePanel from './BaselinePanel';
import FindingDetail from './FindingDetail';
import FindingsList from './FindingsList';
import PostureGrid from './PostureGrid';
import SentinelSettings from './SentinelSettings';
import styles from './style.module.css';

import type { FeatureProps } from '../types';

export { SentinelWidget } from './SentinelWidget';

/**
 * Sentinelle : la vue de flotte, puis le détail d'une machine.
 *
 * Deux niveaux et pas trois. On entre par « qu'est-ce qui ne va pas, et où » —
 * la liste des constats de tout l'espace, au pire d'abord. On descend sur une
 * machine pour sa posture, sa ligne de base et ses réglages. Un troisième niveau
 * n'aurait fait qu'éloigner la seule action qui compte : juger un constat.
 *
 * Aucun sondage : la vue se relit quand le sujet `sentinel` bouge, c'est-à-dire
 * quand le moteur ouvre un constat. Elle est donc muette tant que rien ne se
 * passe, ce qui est l'état normal d'un détecteur.
 */

type Tab = 'findings' | 'posture' | 'baseline' | 'settings';

const SEVERITY_FILTERS: { id: FindingSeverity | null; label: string }[] = [
    { id: null, label: 'Tout' },
    { id: 'high', label: 'Élevé et plus' },
    { id: 'critical', label: 'Critique' }
];

export default function Sentinel({ workspace }: FeatureProps) {
    const [devices, setDevices] = useState<DeviceSentinelState[]>([]);
    const [fleetScore, setFleetScore] = useState<number | null>(null);
    const [findings, setFindings] = useState<Finding[]>([]);
    const [selected, setSelected] = useState<Finding | null>(null);
    const [deviceId, setDeviceId] = useState<string | null>(null);
    const [tab, setTab] = useState<Tab>('findings');
    const [posture, setPosture] = useState<DevicePosture | null>(null);
    const [minSeverity, setMinSeverity] = useState<FindingSeverity | null>(null);
    const [showResolved, setShowResolved] = useState(false);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const workspaceId = workspace.id;
    const device = devices.find((d) => d.deviceId === deviceId) ?? null;

    const reload = useCallback(async () => {
        try {
            const [overview, list] = await Promise.all([
                ws.send('sentinel.overview', {}),
                ws.send('sentinel.findings', {
                    deviceId: null,
                    state: showResolved ? null : 'open',
                    minSeverity,
                    rule: null,
                    limit: 200,
                    offset: 0
                })
            ]);
            setDevices(overview.devices);
            setFleetScore(overview.fleetScore);
            setFindings(list.findings);
            setError(null);
        } catch {
            setError('Chargement impossible.');
        } finally {
            setLoading(false);
        }
    }, [workspaceId, minSeverity, showResolved]);

    useEffect(() => {
        void reload();
        const offInvalidate = onResourceChange('sentinel.findings', () => void reload());
        const offState = ws.onStateChange((s) => {
            if (s === 'open') void reload();
        });
        return () => {
            offInvalidate();
            offState();
        };
    }, [reload]);

    // La posture se charge à la demande : c'est une lecture par appareil, et la
    // vue de flotte n'en a pas besoin pour s'afficher (elle porte déjà le score).
    useEffect(() => {
        if (tab !== 'posture' || !deviceId) return;
        let cancelled = false;
        void (async () => {
            try {
                const res = await ws.send('sentinel.posture', { deviceId });
                if (!cancelled) setPosture(res.posture);
            } catch {
                if (!cancelled) setError('Posture indisponible.');
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [tab, deviceId]);

    /** Après une écriture : la vue **et** le compteur partagé, que le serveur ne nous renvoie pas. */
    const afterWrite = useCallback(async () => {
        await reload();
        await refreshSentinel();
    }, [reload]);

    const acknowledge = useCallback(
        async (scope: AllowScope, reason: string | null) => {
            if (!selected) return;
            const res = await ws.send('sentinel.acknowledge', { findingId: selected.id, scope, reason });
            setSelected(res.finding);
            await afterWrite();
        },
        [selected, afterWrite]
    );

    const reopen = useCallback(async () => {
        if (!selected) return;
        const res = await ws.send('sentinel.reopen', { findingId: selected.id });
        setSelected(res.finding);
        await afterWrite();
    }, [selected, afterWrite]);

    const visible = deviceId ? findings.filter((f) => f.deviceId === deviceId) : findings;

    return (
        <div className={styles.root}>
            <aside className={styles.sidebar}>
                <header className={styles.fleetHead}>
                    <span className={styles.fleetLabel}>Posture de la flotte</span>
                    <span className={styles.fleetScore}>{fleetScore === null ? '—' : fleetScore}</span>
                </header>

                <button
                    type='button'
                    className={`${styles.deviceRow} ${deviceId === null ? styles.deviceRowActive : ''}`}
                    onClick={() => {
                        setDeviceId(null);
                        setTab('findings');
                    }}
                >
                    <span className={styles.deviceName}>Tous les appareils</span>
                </button>

                {devices.map((d) => {
                    const open = d.open.critical + d.open.high + d.open.low + d.open.info;
                    return (
                        <button
                            key={d.deviceId}
                            type='button'
                            className={`${styles.deviceRow} ${
                                d.deviceId === deviceId ? styles.deviceRowActive : ''
                            } ${d.enabled ? '' : styles.deviceRowOff}`}
                            onClick={() => {
                                setDeviceId(d.deviceId);
                                setTab(d.enabled ? 'findings' : 'settings');
                            }}
                        >
                            <span className={styles.deviceName}>{d.deviceName}</span>
                            <span className={styles.deviceMeta}>
                                {!d.enabled ? (
                                    <span className={styles.deviceOff}>non surveillé</span>
                                ) : d.learning ? (
                                    <span className={styles.deviceLearning}>apprentissage</span>
                                ) : open > 0 ? (
                                    <span
                                        className={
                                            d.open.critical > 0
                                                ? styles.sevCritical
                                                : d.open.high > 0
                                                  ? styles.sevHigh
                                                  : styles.sevLow
                                        }
                                    >
                                        {open}
                                    </span>
                                ) : (
                                    <span className={styles.deviceClear}>ok</span>
                                )}
                            </span>
                        </button>
                    );
                })}
            </aside>

            <main className={styles.main}>
                {device && (
                    <nav className={styles.tabs}>
                        {(['findings', 'posture', 'baseline', 'settings'] as Tab[]).map((t) => (
                            <button
                                key={t}
                                type='button'
                                className={`${styles.tab} ${t === tab ? styles.tabActive : ''}`}
                                onClick={() => setTab(t)}
                            >
                                {t === 'findings'
                                    ? 'Constats'
                                    : t === 'posture'
                                      ? 'Posture'
                                      : t === 'baseline'
                                        ? 'Ligne de base'
                                        : 'Réglages'}
                            </button>
                        ))}
                    </nav>
                )}

                {error && <p className={styles.error}>{error}</p>}

                {tab === 'findings' && (
                    <>
                        <div className={styles.filters}>
                            {SEVERITY_FILTERS.map((f) => (
                                <button
                                    key={f.label}
                                    type='button'
                                    className={`${styles.filter} ${f.id === minSeverity ? styles.filterActive : ''}`}
                                    onClick={() => setMinSeverity(f.id)}
                                >
                                    {f.label}
                                </button>
                            ))}
                            <label className={styles.filterCheck}>
                                <input
                                    type='checkbox'
                                    checked={showResolved}
                                    onChange={(e) => setShowResolved(e.target.checked)}
                                />
                                Inclure acquittés et résolus
                            </label>
                        </div>

                        <div className={styles.split}>
                            <div className={styles.listPane}>
                                {loading ? (
                                    <p className={styles.empty}>Chargement…</p>
                                ) : (
                                    <FindingsList
                                        findings={visible}
                                        selectedId={selected?.id ?? null}
                                        onSelect={setSelected}
                                        showDevice={deviceId === null}
                                    />
                                )}
                            </div>
                            <div className={styles.detailPane}>
                                {selected ? (
                                    <FindingDetail
                                        finding={selected}
                                        onAcknowledge={acknowledge}
                                        onReopen={reopen}
                                        onOpenSnapshot={null}
                                    />
                                ) : (
                                    <p className={styles.empty}>
                                        Sélectionnez un constat pour voir ce qui a été observé.
                                    </p>
                                )}
                            </div>
                        </div>
                    </>
                )}

                {tab === 'posture' && device && posture && <PostureGrid posture={posture} />}

                {tab === 'baseline' && device && (
                    <BaselinePanel
                        deviceId={device.deviceId}
                        deviceName={device.deviceName}
                        onChanged={() => void afterWrite()}
                    />
                )}

                {tab === 'settings' && device && (
                    <SentinelSettings
                        device={device}
                        onChanged={(next) => {
                            setDevices((prev) => prev.map((d) => (d.deviceId === next.deviceId ? next : d)));
                            void refreshSentinel();
                        }}
                    />
                )}
            </main>
        </div>
    );
}
