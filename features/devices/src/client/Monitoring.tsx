import { useCallback, useEffect, useRef, useState } from 'react';
import {
    Button,
    openInfo,
    PlanPausedBadge,
    PlanPausedNotice,
    StickyHeader,
    useDragReorder,
    useLiveOutlines,
    useLiveSegment,
    useWorkspacePermissions
} from 'deveye-sdk-client';

import type { FleetDevice } from '../contracts/commands';
import { agentUpdatable } from './agentVersion';
import { api } from './api';
import { MonitoringInfo } from './MonitoringInfo';
import MonitoringPanel from './MonitoringPanel';
import { useDevices } from './store';
import { useAgentUpdate } from './useAgentUpdate';
import { formatEvery } from './utils';
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
    /** Ouvre le dialogue d'appairage ; absent quand le rôle n'appaire pas. */
    onPair?: () => void;
}

/** Le geste d'appairage, au bout de la liste qu'il allonge. */
function PairCard({ onPair }: { onPair: () => void }) {
    return (
        <button type='button' className={styles.pairCard} onClick={onPair}>
            <span className={`icon icon-plus ${styles.pairCardIcon}`} />
            Appairer un appareil
        </button>
    );
}

export default function Monitoring({ onPair }: MonitoringProps) {
    const { devices: stored, loading } = useDevices();
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const updater = useAgentUpdate();
    const permissions = useWorkspacePermissions();
    const canWrite = permissions.canFeature('devices', 'write');
    /** L'écriture sur CET appareil : une surcharge par élément peut l'abaisser. */
    const canWriteOn = (id: string) => permissions.canFeature('devices', 'write', id);

    /**
     * L'ordre posé à la main, en attendant que le serveur le confirme : le
     * magasin partagé n'a pas de setter, on superpose l'ordre local le temps de
     * l'aller-retour.
     */
    const [ordered, setOrdered] = useState<FleetDevice[] | null>(null);
    /** Un glissé est en cours : la liste ne doit pas bouger dessous. */
    const dragging = useRef(false);
    const devices = ordered ?? stored;
    // Les archivés (révoqués ou supprimés) se rangent à part, repliés : leur
    // historique se consulte et s'efface, rien d'autre.
    const live = devices.filter((d) => d.status !== 'archived');
    const archived = devices.filter((d) => d.status === 'archived');
    const [showArchived, setShowArchived] = useState(false);
    const archivedOpen = showArchived || archived.some((d) => d.id === selectedId);

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
        // La commande veut la liste complète : les archivés, qu'on ne glisse
        // pas, ferment la marche.
        const full = [
            ...ids.map(String),
            ...currentList.current.filter((d) => d.status === 'archived').map((d) => d.id)
        ];
        setOrdered(full.flatMap((id) => byId.get(id) ?? []));
        api.send('devices.reorder', { ids: full }).catch(() => setOrdered(null));
    }, []);

    const drag = useDragReorder<HTMLDivElement, HTMLSpanElement>({
        ids: live.map((d) => d.id),
        rowSelector: '[data-device-card]',
        onReorder: reorder,
        onDragStateChange: (active) => {
            dragging.current = active;
        }
    });

    const updatableIds = devices.filter((d) => d.online && agentUpdatable(d) && canWriteOn(d.id)).map((d) => d.id);

    // Auto-select the first device, and drop a selection that points at a
    // device which no longer exists.
    useEffect(() => {
        if (devices.length === 0) {
            if (selectedId !== null) setSelectedId(null);
        } else if (selectedId === null || !devices.some((d) => d.id === selectedId)) {
            // Un appareil vivant d'abord : les archivés sont repliés.
            setSelectedId((devices.find((d) => d.status !== 'archived') ?? devices[0]).id);
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

    /** Une carte de la liste. Seules les cartes vivantes se réordonnent. */
    const renderCard = (d: FleetDevice, reorderable: boolean) => {
        const canUpdate = d.online && agentUpdatable(d) && canWriteOn(d.id);
        return (
            <div
                key={d.id}
                role='button'
                tabIndex={0}
                data-device-card={reorderable ? '' : undefined}
                className={`${styles.deviceCard} ${d.id === selectedId ? styles.selected : ''} ${drag.draggingId === d.id ? styles.deviceCardDragging : ''} ${reorderable ? '' : styles.deviceCardArchived}`}
                {...outlineOf(d.id)}
                onClick={() => setSelectedId(d.id)}
                onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') setSelectedId(d.id);
                }}
            >
                {/* Seule la poignée renonce au défilement tactile. */}
                {canWrite && reorderable && (
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
                <div className={`${styles.statusDot} ${d.online ? styles.online : styles.offline}`} />
                <div className={styles.deviceCardInfo}>
                    <span className={styles.deviceCardName}>
                        {d.name}
                        {/* Venu d'un autre espace : il se règle et se
                            supprime chez lui, pas d'ici. */}
                        {d.foreign && <span className={styles.sharedTag}>partagé</span>}
                        {/* Relié à nouveau : son agent attend qu'on l'approuve. */}
                        {d.status === 'pending' && <span className={styles.pendingTag}>en attente</span>}
                    </span>
                    <span className={styles.deviceCardPlatform}>
                        {d.platform}
                        {d.agentVersion && ` · v${d.agentVersion}`}
                        {d.status === 'active' && ` · relevé ${formatEvery(d.effectiveMetricIntervalSeconds)}`}
                    </span>
                    {d.planPaused && <PlanPausedBadge className={styles.pausedTag} />}
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
    };

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
                        {onPair && <PairCard onPair={onPair} />}
                    </div>
                </>
            ) : (
                <div className={styles.grid}>
                    {/* Left: title + device list */}
                    <div className={styles.deviceListFull}>
                        <StickyHeader>
                            <MonitoringTitle
                                sidebar
                                updatableIds={updatableIds}
                                onUpdateAll={() => void updater.updateAll(updatableIds)}
                                updating={updater.anyBusy}
                            />
                        </StickyHeader>
                        <PlanPausedNotice
                            count={devices.filter((d) => d.planPaused).length}
                            one='appareil'
                            many='appareils'
                        />
                        {/* Boîte intérieure, et non `.deviceListFull` : elle ancre
                            la barre d'insertion et suit le défilement. */}
                        <div ref={drag.listRef} className={styles.deviceCards}>
                            {live.map((d) => renderCard(d, true))}
                            <span ref={drag.barRef} className={styles.dropBar} aria-hidden='true' />
                        </div>
                        {onPair && <PairCard onPair={onPair} />}
                        {archived.length > 0 && (
                            <div className={styles.archivedGroup}>
                                <div>
                                    <Button
                                        variant='ghost'
                                        icon='archive'
                                        onClick={() => setShowArchived(!archivedOpen)}
                                        aria-expanded={archivedOpen}
                                    >
                                        {archivedOpen ? 'Masquer les archivés' : `Archivés (${archived.length})`}
                                    </Button>
                                </div>
                                {archivedOpen && (
                                    <div className={styles.deviceCards}>
                                        {archived.map((d) => renderCard(d, false))}
                                    </div>
                                )}
                            </div>
                        )}
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
