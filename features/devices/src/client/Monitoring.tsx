import { useCallback, useEffect, useRef, useState } from 'react';
import type { Device } from '@deveye/types';
import { openInfo, useDragReorder, useLiveOutlines, useLiveSegment, useWorkspacePermissions } from 'deveye-sdk-client';

import { agentUpdatable } from './agentVersion';
import { api } from './api';
import { MonitoringInfo } from './MonitoringInfo';
import MonitoringPanel from './MonitoringPanel';
import { useDevices } from './store';
import { useAgentUpdate } from './useAgentUpdate';
import styles from './style.module.css';

export function MonitoringWidget() {
    const { devices: allDevices } = useDevices();
    // Archived devices are kept only for their history.
    const devices = allDevices.filter((d) => d.status !== 'archived');
    const onlineCount = devices.filter((d) => d.online).length;
    // A fixed 2×2 grid: past four devices the last slot becomes a "+N autres"
    // marker, so the block's height never varies with the fleet.
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

/**
 * L'en-tête de la colonne des appareils : le titre, l'aide et la mise à jour de
 * tous les agents. Tout tient contre la liste qu'il coiffe : la vue n'a plus de
 * barre au-dessus des volets.
 */
function MonitoringTitle({
    sidebar,
    updatableIds,
    onUpdateAll,
    updating
}: {
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
                    <button
                        type='button'
                        className={styles.iconHeaderBtn}
                        onClick={() =>
                            void openInfo({
                                title: 'Monitoring — comment ça marche',
                                body: <MonitoringInfo />,
                                width: 560
                            })
                        }
                        title='Comment ça marche ?'
                    >
                        <span className='icon icon-info' />
                    </button>
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
                </div>
            </div>
            <p className={styles.subtitle}>Surveillance et historique de vos appareils</p>
        </div>
    );
}

interface MonitoringProps {
    /** Ouvre le dialogue des codes de liaison ; absent quand le rôle n'appaire pas. */
    onPair?: () => void;
    /** Un code est en cours de génération : le bouton attend. */
    pairing?: boolean;
}

/** Le geste d'appairage, au bout de la liste qu'il allonge. */
function PairCard({ onPair, pairing }: { onPair: () => void; pairing?: boolean }) {
    return (
        <button type='button' className={styles.pairCard} onClick={onPair} disabled={pairing}>
            <span className={`icon icon-plus ${styles.pairCardIcon}`} />
            {pairing ? 'Génération du code…' : 'Appairer un appareil'}
        </button>
    );
}

export default function Monitoring({ onPair, pairing }: MonitoringProps) {
    const { devices: stored, loading } = useDevices();
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const updater = useAgentUpdate();
    const canWrite = useWorkspacePermissions().canFeature('devices', 'write');

    /**
     * L'ordre posé à la main, en attendant que le serveur le confirme : le
     * magasin partagé n'a pas de setter, on superpose l'ordre local le temps de
     * l'aller-retour.
     */
    const [ordered, setOrdered] = useState<Device[] | null>(null);
    /** Un glissé est en cours : la liste ne doit pas bouger dessous. */
    const dragging = useRef(false);
    const devices = ordered ?? stored;

    // Le serveur reprend la main dès qu'il a répondu, jamais pendant un glissé.
    useEffect(() => {
        if (!dragging.current) setOrdered(null);
    }, [stored]);

    // La liste courante, lue au moment du dépôt : `reorder` est mémoïsé, il ne
    // doit pas capturer un tableau vieux d'un rendu.
    const currentList = useRef(devices);
    currentList.current = devices;

    /**
     * Applique un dépôt : localement d'abord, pour que la carte reste là où on
     * l'a lâchée, puis on persiste. Un échec rend la main au serveur.
     */
    const reorder = useCallback((ids: (string | number)[]) => {
        const byId = new Map(currentList.current.map((d) => [d.id, d]));
        setOrdered(ids.flatMap((id) => byId.get(String(id)) ?? []));
        api.send('devices.reorder', { ids: ids.map(String) }).catch(() => setOrdered(null));
    }, []);

    const drag = useDragReorder<HTMLDivElement, HTMLSpanElement>({
        ids: devices.map((d) => d.id),
        rowSelector: '[data-device-card]',
        onReorder: reorder,
        onDragStateChange: (active) => {
            dragging.current = active;
        }
    });

    const updatableIds = devices.filter((d) => d.online && agentUpdatable(d)).map((d) => d.id);

    // Auto-select the first device, and drop a selection that points at a
    // device which no longer exists.
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

    return (
        <div className={styles.container}>
            {loading && devices.length === 0 ? (
                <>
                    <MonitoringTitle />
                    <div className={styles.loader}>Chargement...</div>
                </>
            ) : devices.length === 0 ? (
                <>
                    <MonitoringTitle />
                    <div className={styles.empty}>
                        <span className={`icon icon-server ${styles.emptyIcon}`} />
                        <p>Aucun appareil dans cet espace</p>
                        <p className={styles.hint}>
                            Appairez une machine, ou partagez un appareil d’un autre espace depuis ses réglages.
                        </p>
                        {onPair && <PairCard onPair={onPair} pairing={pairing} />}
                    </div>
                </>
            ) : (
                <div className={styles.grid}>
                    {/* Left: title + device list */}
                    <div className={styles.deviceListFull}>
                        <MonitoringTitle
                            sidebar
                            updatableIds={updatableIds}
                            onUpdateAll={() => void updater.updateAll(updatableIds)}
                            updating={updater.anyBusy}
                        />
                        {/* Boîte intérieure, et non `.deviceListFull` : elle ancre
                            la barre d'insertion et suit le défilement. */}
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
                                        {/* Seule la poignée renonce au défilement tactile. */}
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
                                            <span className={styles.deviceCardName}>
                                                {d.name}
                                                {/* Venu d'un autre espace : il se règle et se
                                                    supprime chez lui, pas d'ici. */}
                                                {d.foreign && <span className={styles.sharedTag}>partagé</span>}
                                            </span>
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
                        {onPair && <PairCard onPair={onPair} pairing={pairing} />}
                    </div>

                    {/* Right: per-device panel, scrolling independently of the list. */}
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
