import { useCallback, useEffect, useRef, useState } from 'react';
import type { Device } from 'deveye-types';
import { ws } from '@/api/ws';
import { useDragReorder } from '@/dragReorder';
import { useDevices } from '@/stores/devices';
import { useWorkspacePermissions } from '@/stores/workspace';
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
    const { devices: stored, loading } = useDevices();
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const updater = useAgentUpdate();
    const canWrite = useWorkspacePermissions().canFeature('devices', 'write');

    /**
     * L'ordre posé à la main, en attendant que le serveur le confirme.
     *
     * La liste vient d'un magasin partagé (accueil, topbar, Monitoring) qui n'a
     * pas de setter : on superpose donc l'ordre local le temps de l'aller-retour,
     * plutôt que de laisser la carte revenir à sa place avant d'y repartir.
     */
    const [ordered, setOrdered] = useState<Device[] | null>(null);
    /** Un glissé est en cours : la liste ne doit pas bouger dessous. */
    const dragging = useRef(false);
    const devices = ordered ?? stored;

    // Le serveur reprend la main dès qu'il a répondu — mais jamais pendant un
    // glissé, où une relecture réordonnerait les lignes sous le pointeur.
    useEffect(() => {
        if (!dragging.current) setOrdered(null);
    }, [stored]);

    // La liste courante, lue au moment du dépôt : `reorder` est mémoïsé, il ne
    // doit pas capturer un tableau vieux d'un rendu.
    const currentList = useRef(devices);
    currentList.current = devices;

    /**
     * Applique un dépôt : on range d'abord localement, pour que la carte reste
     * là où on l'a lâchée sans aller-retour, puis on persiste. Un échec rend la
     * main au serveur, seul détenteur de l'ordre réellement enregistré.
     */
    const reorder = useCallback((ids: (string | number)[]) => {
        const byId = new Map(currentList.current.map((d) => [d.id, d]));
        setOrdered(ids.flatMap((id) => byId.get(String(id)) ?? []));
        ws.send('device.reorder', { ids: ids.map(String) }).catch(() => setOrdered(null));
    }, []);

    const drag = useDragReorder<HTMLDivElement, HTMLSpanElement>({
        ids: devices.map((d) => d.id),
        rowSelector: '[data-device-card]',
        onReorder: reorder,
        onDragStateChange: (active) => {
            dragging.current = active;
        }
    });

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
                        {/* Boîte intérieure, et non `.deviceListFull` : c'est
                            elle qui ancre la barre d'insertion, et comme elle
                            n'est pas le conteneur défilant, sa position suit le
                            défilement toute seule. */}
                        <div ref={drag.listRef} className={styles.deviceCards}>
                            {devices.map((d) => {
                                const canUpdate = d.online && agentUpdatable(d);
                                return (
                                    <div
                                        key={d.id}
                                        role='button'
                                        tabIndex={0}
                                        data-device-card=''
                                        className={`${styles.deviceCard} ${d.id === selectedId ? styles.selected : ''} ${drag.draggingId === d.id ? styles.deviceCardDragging : ''}`}
                                        {...outlineOf(d.id)}
                                        onClick={() => setSelectedId(d.id)}
                                        onKeyDown={(e) => {
                                            if (e.key === 'Enter' || e.key === ' ') setSelectedId(d.id);
                                        }}
                                    >
                                        {/* Poignée d'abord, comme dans Uptime, Git et les
                                            bases de données : seule elle renonce au
                                            défilement tactile, le reste de la carte
                                            continue de faire défiler la liste. */}
                                        {canWrite && (
                                            <button
                                                type='button'
                                                className={styles.grip}
                                                aria-label='Réordonner l’appareil'
                                                onPointerDown={(e) => drag.onGripPointerDown(e, d.id)}
                                                onClick={(e) => e.stopPropagation()}
                                            >
                                                <span className='icon icon-drag' />
                                            </button>
                                        )}
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
                            <span ref={drag.barRef} className={styles.dropBar} aria-hidden='true' />
                        </div>
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
