import { useEffect, useState } from 'react';
import { useDevices } from '@/stores/devices';
import { openInfo } from '@/Components/InfoPopup';
import type { FeatureProps } from '../types';
import { agentVersionInfo } from '../agentVersion';
import { MonitoringInfo } from './MonitoringInfo';
import MonitoringPanel from './MonitoringPanel';
import styles from './Monitoring.module.css';

// ─── Widget compact ─────────────────────────────────────────────────────────

export function MonitoringWidget() {
    const { devices: allDevices } = useDevices();
    // Archived devices are former machines kept only for their history; don't
    // count them among the live fleet.
    const devices = allDevices.filter((d) => d.status !== 'archived');
    const onlineCount = devices.filter((d) => d.online).length;
    // Show as many devices as comfortably fit, anchored to the bottom; the rest
    // collapse into a "+N autres" marker sitting just above them.
    const MAX_VISIBLE = 3;
    const visible = devices.slice(0, MAX_VISIBLE);
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
                    {hidden > 0 && <span className={styles.moreDevices}>+{hidden} autres</span>}
                    {visible.map((d) => (
                        <div key={d.id} className={`${styles.deviceItem} ${d.online ? styles.online : styles.offline}`}>
                            <div className={`${styles.miniDot} ${d.online ? styles.online : styles.offline}`} />
                            <span className={styles.deviceName}>{d.name}</span>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

// ─── Full view ──────────────────────────────────────────────────────────────

export default function Monitoring({ user: _user, workspace: _ws }: FeatureProps) {
    const { devices, loading } = useDevices();
    const [selectedId, setSelectedId] = useState<string | null>(null);

    // Auto-select the first device.
    useEffect(() => {
        if (selectedId === null && devices.length > 0) setSelectedId(devices[0].id);
    }, [devices, selectedId]);

    const showInfo = () =>
        void openInfo({ title: 'Monitoring — comment ça marche', body: <MonitoringInfo />, width: 560 });

    return (
        <div className={styles.container}>
            <div className={styles.titleRow}>
                <div>
                    <h2 className={styles.title}>Monitoring</h2>
                    <p className={styles.subtitle}>Surveillance et historique de vos appareils</p>
                </div>
                <button className={styles.iconHeaderBtn} onClick={showInfo} title='Comment ça marche ?'>
                    <span className='icon icon-info' />
                </button>
            </div>

            {loading && devices.length === 0 ? (
                <div className={styles.loader}>Chargement...</div>
            ) : devices.length === 0 ? (
                <div className={styles.empty}>
                    <span className={`icon icon-server ${styles.emptyIcon}`} />
                    <p>Aucun appareil configuré</p>
                    <p className={styles.hint}>Liez un agent depuis le menu « Appareils » (en haut à droite).</p>
                </div>
            ) : (
                <div className={styles.grid}>
                    {/* Left: device list */}
                    <div className={styles.deviceListFull}>
                        {devices.map((d) => {
                            const version = agentVersionInfo(d.agentVersion);
                            return (
                                <button
                                    key={d.id}
                                    className={`${styles.deviceCard} ${d.id === selectedId ? styles.selected : ''}`}
                                    onClick={() => setSelectedId(d.id)}
                                >
                                    <div
                                        className={`${styles.statusDot} ${d.online ? styles.online : styles.offline}`}
                                    />
                                    <div className={styles.deviceCardInfo}>
                                        <span className={styles.deviceCardName}>{d.name}</span>
                                        <span className={styles.deviceCardPlatform}>
                                            {d.platform}
                                            {version && ` · v${version.version}`}
                                            {version?.mismatch && (
                                                <span
                                                    className={`icon icon-error ${styles.deviceCardWarn}`}
                                                    title='Mise à jour de l’agent disponible'
                                                />
                                            )}
                                        </span>
                                    </div>
                                </button>
                            );
                        })}
                    </div>

                    {/* Right: per-device panel (shared with the home device popup) */}
                    {selectedId && <MonitoringPanel deviceId={selectedId} onPurged={() => setSelectedId(null)} />}
                </div>
            )}
        </div>
    );
}
