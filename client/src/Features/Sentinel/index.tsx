import { useCallback, useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import type { AllowScope, DevicePosture, DeviceSentinelState, Finding, FindingSeverity } from 'deveye-types';

import { ws } from '@/api/ws';
import { useLiveSegment } from '@/live/useLiveSegment';
import { onResourceChange } from '@/stores/invalidation';
import { refreshSentinel } from '@/stores/sentinel';

import AllowlistSection from './AllowlistSection';
import BaselineSection from './BaselineSection';
import DeviceHeader from './DeviceHeader';
import FindingDetail from './FindingDetail';
import FindingsList from './FindingsList';
import FleetHeader from './FleetHeader';
import NotificationsDialog from './NotificationsDialog';
import PostureGrid from './PostureGrid';
import SentinelDialog from './SentinelDialog';
import styles from './style.module.css';

import type { FeatureProps } from '../types';

export { SentinelWidget } from './SentinelWidget';

/**
 * Sentinelle : la flotte, puis une machine.
 *
 * **Deux niveaux, et aucun onglet.** On entre par « qu'est-ce qui ne va pas, et
 * où » — les constats de tout l'espace, au pire d'abord — et on descend sur une
 * machine, qui se lit alors d'une seule traite : ce qu'on lui reproche, sa
 * posture, puis ce qu'on a appris d'elle.
 *
 * Les onglets d'une première version rangeaient ces trois choses derrière trois
 * clics, alors qu'elles se lisent ensemble et dans cet ordre : on ne consulte
 * pas la posture d'une machine *ou* ses constats, on regarde les constats et on
 * se demande aussitôt si sa configuration les explique. Les réglages, eux, sont
 * une action et non une lecture — d'où un dialogue.
 *
 * Aucun sondage : la vue se relit quand le sujet `sentinel` bouge, c'est-à-dire
 * quand le moteur ouvre un constat. Elle est donc muette tant que rien ne se
 * passe, ce qui est l'état normal d'un détecteur.
 */

/**
 * Largeur du panneau de détail. Vit ici, en une seule constante, parce que deux
 * choses en dépendent : la largeur qu'anime framer-motion, et celle que le
 * contenu garde pendant qu'elle change (voir plus bas).
 */
const DETAIL_WIDTH = 360;

export default function Sentinel({ workspace }: FeatureProps) {
    const [devices, setDevices] = useState<DeviceSentinelState[]>([]);
    const [fleetScore, setFleetScore] = useState<number | null>(null);
    const [findings, setFindings] = useState<Finding[]>([]);
    const [selected, setSelected] = useState<Finding | null>(null);
    const [deviceId, setDeviceId] = useState<string | null>(null);
    const [posture, setPosture] = useState<DevicePosture | null>(null);
    const [minSeverity, setMinSeverity] = useState<FindingSeverity | null>(null);
    const [showSettled, setShowSettled] = useState(false);
    const [settingsFor, setSettingsFor] = useState<DeviceSentinelState | null>(null);
    const [notificationsOpen, setNotificationsOpen] = useState(false);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const workspaceId = workspace.id;
    const device = devices.find((d) => d.deviceId === deviceId) ?? null;

    // Le niveau profond de Sentinelle : la machine ouverte. La racine
    // `view:sentinel` vient de l'accueil ; cette feature n'annonce que le sien.
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
                ws.send('sentinel.overview', {}),
                ws.send('sentinel.findings', {
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
            // Le constat ouvert se resynchronise sur la liste fraîche : sans
            // cela le panneau garderait l'objet capté au clic, et afficherait
            // « ouvert » sur un constat qu'un collègue vient d'acquitter. Il
            // disparaît du filtre courant ⇒ on referme, plutôt que de laisser un
            // détail orphelin de sa liste.
            setSelected((cur) => (cur ? (list.findings.find((f) => f.id === cur.id) ?? null) : null));
            setError(null);
        } catch {
            setError('Chargement impossible.');
        } finally {
            setLoading(false);
        }
    }, [workspaceId, minSeverity, showSettled]);

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
    // vue de flotte n'en a pas besoin pour s'afficher — elle porte déjà le score.
    useEffect(() => {
        if (!deviceId) {
            setPosture(null);
            return;
        }
        let cancelled = false;
        void (async () => {
            try {
                const res = await ws.send('sentinel.posture', { deviceId });
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
            const res = await ws.send('sentinel.acknowledge', { findingId: selected.id, scope, reason });
            setSelected(res.finding);
            await afterWrite();
        },
        [selected, afterWrite]
    );

    const resolve = useCallback(async () => {
        if (!selected) return;
        await ws.send('sentinel.resolve', { findingId: selected.id });
        // Sans `setSelected` : la relecture s'en charge, et elle seule sait quoi
        // faire des deux cas. Le constat quitte le filtre par défaut — le détail
        // se referme ; il reste sous « voir les constats réglés » — le détail se
        // met à jour. Le forcer ici aurait tranché à sa place.
        await afterWrite();
    }, [selected, afterWrite]);

    const reopen = useCallback(async () => {
        if (!selected) return;
        const res = await ws.send('sentinel.reopen', { findingId: selected.id });
        setSelected(res.finding);
        await afterWrite();
    }, [selected, afterWrite]);

    const resetBaseline = useCallback(
        async (id: string) => {
            await ws.send('sentinel.resetBaseline', { deviceId: id });
            await afterWrite();
        },
        [afterWrite]
    );

    const scanNow = useCallback(async (id: string): Promise<boolean> => {
        const res = await ws.send('sentinel.scanNow', { deviceId: id });
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
                                // Toujours la lecture, jamais les réglages : arriver
                                // dans un formulaire parce que la machine n'est pas
                                // encore surveillée était le contraire de ce qu'on
                                // attend d'un clic sur son nom.
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
                    <DeviceHeader device={device} onOpenSettings={() => setSettingsFor(device)} onScanNow={scanNow} />
                ) : (
                    <FleetHeader
                        onOpenNotifications={() => setNotificationsOpen(true)}
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
                                L’activation démarre une fenêtre d’apprentissage pendant laquelle Sentinelle observe
                                sans rien reprocher.
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

                        {/*
                         * Le détail n'occupe la droite **que lorsqu'on en veut un**.
                         * Une colonne vide en permanence prenait un tiers de
                         * l'écran pour n'y afficher qu'une invitation, alors que
                         * la liste est ce qu'on vient lire. Il entre et sort par
                         * la droite, comme le reste des surfaces de l'application.
                         */}
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
                                        // L'opacité ne suit pas le ressort : elle
                                        // doit avoir fini bien avant la largeur.
                                        // Le ressort passe ses dernières dizaines
                                        // de pixels à approcher zéro, et c'est là
                                        // que le contenu, encore visible, se
                                        // réduit à ses aplats de couleur.
                                        opacity: { type: 'tween', duration: 0.12, ease: 'easeOut' }
                                    }}
                                >
                                    {/*
                                     * Le contenu garde sa largeur pendant que le
                                     * panneau perd la sienne : `overflow: hidden`
                                     * le rogne au lieu de le remettre en page.
                                     * Sans ça, la fermeture rejouait à toute
                                     * vitesse une mise en page de 360 px à 0 —
                                     * liseré de gravité, séparations et boutons
                                     * écrasés en barres horizontales et
                                     * verticales, l'espace de quelques images.
                                     */}
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

            <NotificationsDialog open={notificationsOpen} onClose={() => setNotificationsOpen(false)} />

            <SentinelDialog
                open={settingsFor !== null}
                device={settingsFor}
                onClose={() => setSettingsFor(null)}
                onSaved={(next, keepOpen) => {
                    setDevices((prev) => prev.map((d) => (d.deviceId === next.deviceId ? next : d)));
                    // Activer est une action qui se termine : la laisser ouverte
                    // sur un arrière-plan qui se recharge donne l'impression que
                    // rien n'a abouti. Seul un enregistrement de cadences reste.
                    setSettingsFor(keepOpen ? next : null);
                    void refreshSentinel();
                }}
                onReset={resetBaseline}
            />
        </div>
    );
}
