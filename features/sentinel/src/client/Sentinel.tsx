import { useCallback, useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { onResourceChange, onSocketOpen, useActiveWorkspace, useLiveSegment } from 'deveye-sdk-client';
import type { FeatureViewProps } from '@deveye/types/sdk/client';

import type { AllowScope, DevicePosture, DeviceSentinelState, Finding, FindingSeverity } from '../contracts/domain';

import AllowlistSection from './AllowlistSection';
import { api } from './api';
import BaselineSection from './BaselineSection';
import DeviceHeader from './DeviceHeader';
import FindingDetail from './FindingDetail';
import FindingsList from './FindingsList';
import FleetHeader from './FleetHeader';
import PostureGrid from './PostureGrid';
import { refreshSentinel } from './store';
import styles from './style.module.css';

/**
 * Sentinelle : la flotte, puis une machine, qui se lit d'une seule traite
 * (constats, posture, ligne de base). Aucun sondage : la vue se relit quand
 * le sujet `sentinel` bouge.
 */

/** Une seule constante : la largeur qu'anime framer-motion et celle que le contenu garde pendant qu'elle change. */
const DETAIL_WIDTH = 360;

export default function Sentinel(_props: FeatureViewProps) {
    const [devices, setDevices] = useState<DeviceSentinelState[]>([]);
    const [fleetScore, setFleetScore] = useState<number | null>(null);
    const [findings, setFindings] = useState<Finding[]>([]);
    const [selected, setSelected] = useState<Finding | null>(null);
    const [deviceId, setDeviceId] = useState<string | null>(null);
    const [posture, setPosture] = useState<DevicePosture | null>(null);
    const [minSeverity, setMinSeverity] = useState<FindingSeverity | null>(null);
    const [showSettled, setShowSettled] = useState(false);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const workspaceId = useActiveWorkspace()?.id ?? null;
    const device = devices.find((d) => d.deviceId === deviceId) ?? null;

    // La machine ouverte est le niveau profond ; la racine `view:sentinel` vient de l'accueil.
    const liveTarget = useLiveSegment('l1', deviceId);
    useEffect(() => {
        if (!liveTarget) return;
        if (liveTarget.value === null) {
            setDeviceId(null);
            return;
        }
        // Redonné à chaque rendu tant qu'il n'est pas atteint : il suffit
        // d'attendre que la liste soit là.
        if (devices.some((d) => d.deviceId === liveTarget.value)) setDeviceId(liveTarget.value);
    }, [liveTarget, devices]);

    const reload = useCallback(async () => {
        try {
            const [overview, list] = await Promise.all([
                api.send('sentinel.overview', {}),
                api.send('sentinel.findings', {
                    deviceId: null,
                    state: showSettled ? null : 'open',
                    minSeverity,
                    rule: null,
                    limit: 200,
                    offset: 0
                })
            ]);
            setDevices(overview.devices);
            setFleetScore(overview.fleetScore);
            setFindings(list.findings);
            // Resynchronisé sur la liste fraîche : sinon le panneau afficherait
            // « ouvert » sur un constat qu'un collègue vient d'acquitter. Disparu
            // du filtre, on referme.
            setSelected((cur) => (cur ? (list.findings.find((f) => f.id === cur.id) ?? null) : null));
            setError(null);
        } catch {
            setError('Chargement impossible.');
        } finally {
            setLoading(false);
        }
        // Relu quand l'espace change : la liste est celle d'un espace.
    }, [workspaceId, minSeverity, showSettled]);

    // Relecture à chaque (re)connexion et quand le sujet `sentinel` bouge.
    useEffect(() => {
        const offInvalidate = onResourceChange('sentinel.findings', () => void reload());
        const offOpen = onSocketOpen(() => void reload());
        return () => {
            offInvalidate();
            offOpen();
        };
    }, [reload]);

    // La posture se charge à la demande : c'est une lecture par appareil, et la
    // vue de flotte n'en a pas besoin pour s'afficher, elle porte déjà le score.
    useEffect(() => {
        if (!deviceId) {
            setPosture(null);
            return;
        }
        let cancelled = false;
        void (async () => {
            try {
                const res = await api.send('sentinel.posture', { deviceId });
                if (!cancelled) setPosture(res.posture);
            } catch {
                if (!cancelled) setPosture(null);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [deviceId, devices]);

    /** Après une écriture : la vue **et** le compteur partagé, dont le serveur ne renvoie pas l'écho. */
    const afterWrite = useCallback(async () => {
        await reload();
        await refreshSentinel();
    }, [reload]);

    const acknowledge = useCallback(
        async (scope: AllowScope, reason: string | null) => {
            if (!selected) return;
            const res = await api.send('sentinel.acknowledge', { findingId: selected.id, scope, reason });
            setSelected(res.finding);
            await afterWrite();
        },
        [selected, afterWrite]
    );

    const resolve = useCallback(async () => {
        if (!selected) return;
        await api.send('sentinel.resolve', { findingId: selected.id });
        // Sans `setSelected` : la relecture seule sait s'il faut refermer (le
        // constat quitte le filtre) ou mettre à jour.
        await afterWrite();
    }, [selected, afterWrite]);

    const reopen = useCallback(async () => {
        if (!selected) return;
        const res = await api.send('sentinel.reopen', { findingId: selected.id });
        setSelected(res.finding);
        await afterWrite();
    }, [selected, afterWrite]);

    const scanNow = useCallback(async (id: string): Promise<boolean> => {
        const res = await api.send('sentinel.scanNow', { deviceId: id });
        return res.requested;
    }, []);

    const visible = deviceId ? findings.filter((f) => f.deviceId === deviceId) : findings;

    return (
        <div className={styles.root}>
            <aside className={styles.sidebar}>
                <button
                    type='button'
                    className={`${styles.overviewButton} ${deviceId === null ? styles.overviewButtonActive : ''}`}
                    onClick={() => {
                        setDeviceId(null);
                        setSelected(null);
                    }}
                >
                    <span className={styles.overviewTop}>
                        <span className={`icon icon-shield ${styles.overviewIcon}`} aria-hidden='true' />
                        <span
                            className={`${styles.overviewScore} ${
                                fleetScore === null
                                    ? styles.scoreUnknown
                                    : fleetScore >= 80
                                      ? styles.scoreOk
                                      : fleetScore >= 50
                                        ? styles.scoreWarn
                                        : styles.scoreBad
                            }`}
                            aria-label={
                                fleetScore === null
                                    ? 'Score de posture de la flotte : pas encore mesurable'
                                    : `Score de posture de la flotte : ${fleetScore} sur 100`
                            }
                        >
                            {fleetScore === null ? '—' : fleetScore}
                        </span>
                    </span>
                    <span className={styles.overviewLabel}>Vue d’ensemble</span>
                </button>

                <p className={styles.sidebarLabel}>Appareils</p>

                {devices.length === 0 && !loading && (
                    <p className={styles.sidebarEmpty}>Aucun appareil dans cet espace.</p>
                )}

                {devices.map((d) => {
                    const open = d.open.critical + d.open.high + d.open.low + d.open.info;
                    return (
                        <button
                            key={d.deviceId}
                            type='button'
                            className={`${styles.navRow} ${d.deviceId === deviceId ? styles.navRowActive : ''} ${
                                d.enabled ? '' : styles.navRowOff
                            }`}
                            onClick={() => {
                                // Toujours la lecture, jamais les réglages.
                                setDeviceId(d.deviceId);
                                setSelected(null);
                            }}
                        >
                            <span
                                className={`${styles.navDot} ${
                                    !d.enabled
                                        ? styles.dotOff
                                        : d.open.critical > 0
                                          ? styles.sevCritical
                                          : d.open.high > 0
                                            ? styles.sevHigh
                                            : d.learning
                                              ? styles.dotLearning
                                              : styles.dotClear
                                }`}
                            />
                            <span className={styles.navName}>{d.deviceName}</span>
                            {d.enabled && open > 0 && <span className={styles.navCount}>{open}</span>}
                        </button>
                    );
                })}
            </aside>

            <main className={styles.main}>
                {error && <p className={styles.error}>{error}</p>}

                {device ? (
                    <DeviceHeader device={device} onScanNow={scanNow} />
                ) : (
                    <FleetHeader
                        devices={devices}
                        minSeverity={minSeverity}
                        onMinSeverity={setMinSeverity}
                        showSettled={showSettled}
                        onShowSettled={setShowSettled}
                    />
                )}

                {device && !device.enabled ? (
                    <div className={styles.callout}>
                        <span className={`icon icon-shield ${styles.calloutIcon}`} />
                        <div>
                            <p className={styles.calloutTitle}>Cette machine n’est pas surveillée</p>
                            <p className={styles.calloutBody}>
                                Rien n’est relevé sur « {device.deviceName} », et ses journaux ne sont pas lus.
                                L’activation, dans les réglages (onglet Appareils), démarre une fenêtre d’apprentissage
                                pendant laquelle Sentinelle observe sans rien reprocher.
                            </p>
                        </div>
                    </div>
                ) : (
                    <div className={styles.split}>
                        <div className={styles.listPane}>
                            <section className={styles.section}>
                                <h3 className={styles.sectionTitle}>
                                    Constats
                                    {visible.length > 0 && (
                                        <span className={styles.sectionCount}>{visible.length}</span>
                                    )}
                                </h3>
                                {loading ? (
                                    <p className={styles.empty}>Chargement…</p>
                                ) : (
                                    <FindingsList
                                        findings={visible}
                                        selectedId={selected?.id ?? null}
                                        onSelect={setSelected}
                                        showDevice={deviceId === null}
                                        learning={device?.learning ?? false}
                                    />
                                )}
                            </section>

                            {device && posture && (
                                <section className={styles.section}>
                                    <h3 className={styles.sectionTitle}>Posture</h3>
                                    <PostureGrid posture={posture} probes={device.probes} />
                                </section>
                            )}

                            {device && <BaselineSection device={device} />}

                            <AllowlistSection deviceId={deviceId} onChanged={() => void afterWrite()} />
                        </div>

                        {/* Le détail n'occupe la droite que lorsqu'on en veut un. */}
                        <AnimatePresence>
                            {selected && (
                                <motion.aside
                                    key='detail'
                                    className={styles.detailPane}
                                    initial={{ x: 24, width: 0, opacity: 0 }}
                                    animate={{ x: 0, width: DETAIL_WIDTH, opacity: 1 }}
                                    exit={{ x: 24, width: 0, opacity: 0 }}
                                    transition={{
                                        type: 'spring',
                                        stiffness: 380,
                                        damping: 34,
                                        // L'opacité doit avoir fini bien avant la
                                        // largeur : le ressort passe ses derniers
                                        // pixels à approcher zéro, contenu visible.
                                        opacity: { type: 'tween', duration: 0.12, ease: 'easeOut' }
                                    }}
                                >
                                    {/* Le contenu garde sa largeur pendant que le
                                        panneau perd la sienne : `overflow: hidden`
                                        le rogne au lieu de le remettre en page. */}
                                    <div className={styles.detailInner} style={{ width: DETAIL_WIDTH }}>
                                        <FindingDetail
                                            finding={selected}
                                            onAcknowledge={acknowledge}
                                            onResolve={resolve}
                                            onReopen={reopen}
                                            onClose={() => setSelected(null)}
                                        />
                                    </div>
                                </motion.aside>
                            )}
                        </AnimatePresence>
                    </div>
                )}
            </main>
        </div>
    );
}
