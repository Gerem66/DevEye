import { useEffect, useState } from 'react';
import { useDevices } from '@/stores/devices';
import { openInfo } from '@/Components/InfoPopup';
import type { FeatureProps } from '../types';
import { MonitoringInfo } from './MonitoringInfo';
import MonitoringPanel from './MonitoringPanel';
import { useAgentUpdate } from './useAgentUpdate';
import { agentUpdatable } from '../agentVersion';
import styles from './Monitoring.module.css';
import { useLiveOutlines } from '@/live/useLiveOutline';
import { useLiveSegment } from '@/live/useLiveSegment';

// ─── Widget compact ─────────────────────────────────────────────────────────

export function MonitoringWidget() {
    const { devices: allDevices } = useDevices();
    // Archived devices are former machines kept only for their history; don't
    // count them among the live fleet.
    const devices = allDevices.filter((d) => d.status !== 'archived');
    const onlineCount = devices.filter((d) => d.online).length;
    // The list is a fixed 2×2 grid anchored to the bottom of the card: two rows
    // is all the widget's height budget allows, and two columns use the width
    // that a single column wasted. Past four devices the last slot becomes a
    // "+N autres" marker, so the block's height never varies with the fleet.
    const SLOTS = 4;
    const visible = devices.slice(0, devices.length > SLOTS ? SLOTS - 1 : SLOTS);
    const hidden = devices.length - visible.length;
    return (
        <div className={styles.widgetContent}>
            <div className={styles.stat}>
                <span className={styles.statValue}>{onlineCount}</span>
                <span className={styles.statLabel}>en ligne</span>
            </div>
            {devices.length === 0 ? (
                <span className={styles.widgetFoot}>Aucun appareil connecté</span>
            ) : (
                <div className={styles.deviceList}>
                    {visible.map((d) => (
                        <div key={d.id} className={`${styles.deviceItem} ${d.online ? styles.online : styles.offline}`}>
                            <div className={`${styles.miniDot} ${d.online ? styles.online : styles.offline}`} />
                            <span className={styles.deviceName}>{d.name}</span>
                        </div>
                    ))}
                    {hidden > 0 && <span className={styles.moreDevices}>+{hidden} autres</span>}
                </div>
            )}
        </div>
    );
}

// ─── Full view ──────────────────────────────────────────────────────────────

/**
 * Feature title + "how it works" info button (right-aligned, hugging the panel),
 * with an optional "update all agents" button to its left. Rendered in the sidebar
 * (grid view) so it doesn't eat a full-width band, or above the loading/empty states.
 */
function MonitoringTitle({
    onInfo,
    sidebar,
    updatableIds,
    onUpdateAll,
    updating
}: {
    onInfo: () => void;
    sidebar?: boolean;
    updatableIds?: string[];
    onUpdateAll?: () => void;
    updating?: boolean;
}) {
    const count = updatableIds?.length ?? 0;
    return (
        <div className={sidebar ? styles.titleSidebar : ''}>
            <div className={styles.titleHead}>
                <h2 className={styles.title}>Monitoring</h2>
                <div className={styles.titleActions}>
                    {count > 0 && onUpdateAll && (
                        <button
                            className={`${styles.iconHeaderBtn} ${styles.iconHeaderUpdate}`}
                            onClick={onUpdateAll}
                            disabled={updating}
                            title={`Mettre à jour ${count} agent${count > 1 ? 's' : ''}`}
                        >
                            <span className={`icon ${updating ? `icon-spinner ${styles.spinning}` : 'icon-cloud'}`} />
                        </button>
                    )}
                    <button className={styles.iconHeaderBtn} onClick={onInfo} title='Comment ça marche ?'>
                        <span className='icon icon-info' />
                    </button>
                </div>
            </div>
            <p className={styles.subtitle}>Surveillance et historique de vos appareils</p>
        </div>
    );
}

export default function Monitoring({ user: _user, workspace: _ws }: FeatureProps) {
    const { devices, loading } = useDevices();
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const updater = useAgentUpdate();

    // Devices whose agent runs an older build than this interface (online).
    const updatableIds = devices.filter((d) => d.online && agentUpdatable(d)).map((d) => d.id);

    // Keep a valid selection: auto-select the first device, and drop a selection
    // that points at a device which no longer exists (e.g. deleted elsewhere).
    useEffect(() => {
        if (devices.length === 0) {
            if (selectedId !== null) setSelectedId(null);
        } else if (selectedId === null || !devices.some((d) => d.id === selectedId)) {
            setSelectedId(devices[0].id);
        }
    }, [devices, selectedId]);

    // Le niveau profond de Monitoring : l'appareil consulté.
    const outlineOf = useLiveOutlines('l1');
    const liveTarget = useLiveSegment('l1', selectedId);
    useEffect(() => {
        if (!liveTarget) return;
        if (liveTarget.value === null) return;
        if (devices.some((d) => d.id === liveTarget.value)) setSelectedId(liveTarget.value);
    }, [liveTarget, devices]);

    const showInfo = () =>
        void openInfo({ title: 'Monitoring — comment ça marche', body: <MonitoringInfo />, width: 560 });

    return (
        <div className={styles.container}>
            {loading && devices.length === 0 ? (
                <>
                    <MonitoringTitle onInfo={showInfo} />
                    <div className={styles.loader}>Chargement...</div>
                </>
            ) : devices.length === 0 ? (
                <>
                    <MonitoringTitle onInfo={showInfo} />
                    <div className={styles.empty}>
                        <span className={`icon icon-server ${styles.emptyIcon}`} />
                        <p>Aucun appareil configuré</p>
                        <p className={styles.hint}>Liez un agent depuis le menu « Appareils » (en haut à droite).</p>
                    </div>
                </>
            ) : (
                <div className={styles.grid}>
                    {/* Left: title + device list */}
                    <div className={styles.deviceListFull}>
                        <MonitoringTitle
                            onInfo={showInfo}
                            sidebar
                            updatableIds={updatableIds}
                            onUpdateAll={() => void updater.updateAll(updatableIds)}
                            updating={updater.anyBusy}
                        />
                        {devices.map((d) => {
                            const canUpdate = d.online && agentUpdatable(d);
                            return (
                                <div
                                    key={d.id}
                                    role='button'
                                    tabIndex={0}
                                    className={`${styles.deviceCard} ${d.id === selectedId ? styles.selected : ''}`}
                                    {...outlineOf(d.id)}
                                    onClick={() => setSelectedId(d.id)}
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter' || e.key === ' ') setSelectedId(d.id);
                                    }}
                                >
                                    <div
                                        className={`${styles.statusDot} ${d.online ? styles.online : styles.offline}`}
                                    />
                                    <div className={styles.deviceCardInfo}>
                                        <span className={styles.deviceCardName}>{d.name}</span>
                                        <span className={styles.deviceCardPlatform}>
                                            {d.platform}
                                            {d.agentVersion && ` · v${d.agentVersion}`}
                                        </span>
                                    </div>
                                    {canUpdate && (
                                        <button
                                            className={styles.cardUpdateBtn}
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                void updater.update(d.id);
                                            }}
                                            disabled={updater.isBusy(d.id)}
                                            title={
                                                d.latestAgentVersion
                                                    ? `Mettre à jour l’agent vers la v${d.latestAgentVersion}`
                                                    : 'Mettre à jour l’agent'
                                            }
                                        >
                                            <span
                                                className={`icon ${updater.isBusy(d.id) ? `icon-spinner ${styles.spinning}` : 'icon-cloud'}`}
                                            />
                                        </button>
                                    )}
                                </div>
                            );
                        })}
                    </div>

                    {/* Right: per-device panel (shared with the home device popup),
                        wrapped so it scrolls independently of the device list. */}
                    {selectedId && (
                        <div className={styles.panelScroll}>
                            <MonitoringPanel deviceId={selectedId} />
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
