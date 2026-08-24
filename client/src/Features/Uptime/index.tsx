import { useCallback, useEffect, useRef, useState } from 'react';

import { ws } from '@/api/ws';
import { FeatureSettingsButton } from '@/Components/FeatureSettings';
import { onResourceChange } from '@/stores/invalidation';
import { useLiveSegment } from '@/live/useLiveSegment';
import Button from '@/Components/Button';
import { refreshUptime } from '@/stores/uptime';

import ServiceDetail from './ServiceDetail';
import { ServiceDialog } from './ServiceDialog';
import ServiceList from './ServiceList';
import styles from './style.module.css';

import type { UptimeService } from '@deveye/types';
import type { FeatureProps } from '../types';

export default function Uptime({ workspace }: FeatureProps) {
    const [services, setServices] = useState<UptimeService[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [selectedId, setSelectedId] = useState<number | null>(null);
    /** A row is in flight: the periodic reload must not reshuffle under it. */
    const dragging = useRef(false);

    const workspaceId = workspace.id;

    // Le niveau profond d'Uptime : le service ouvert. La racine `view:uptime`
    // vient de l'accueil ; cette feature n'annonce que le sien.
    const liveTarget = useLiveSegment('l1', selectedId === null ? null : String(selectedId));
    useEffect(() => {
        if (!liveTarget) return;
        if (liveTarget.value === null) {
            setSelectedId(null);
            return;
        }
        const id = Number(liveTarget.value);
        // Redonné à chaque rendu tant qu'il n'est pas atteint : il suffit
        // d'attendre que la liste soit là.
        if (services.some((svc) => svc.id === id)) setSelectedId(id);
    }, [liveTarget, services]);

    const reload = useCallback(async () => {
        try {
            const res = await ws.send('uptime.list', {});
            setServices(res.services);
            setError(null);
        } catch {
            setError('Chargement impossible.');
        } finally {
            setLoading(false);
        }
    }, [workspaceId]);

    // Relecture à l'ouverture, à chaque (re)connexion, et quand le sujet
    // `uptime` bouge — une écriture d'un autre membre, ou une transition d'état
    // signalée par le moniteur de fond. Plus de minuteur : la liste ne vieillit
    // plus toute seule, elle est prévenue.
    useEffect(() => {
        void reload();
        const offInvalidate = onResourceChange('uptime.list', () => {
            // Une relecture réordonne la liste sous le pointeur : jamais pendant
            // un glisser-déposer.
            if (!dragging.current) void reload();
        });
        const off = ws.onStateChange((s) => {
            if (s === 'open') void reload();
        });
        return () => {
            offInvalidate();
            off();
        };
    }, [reload]);

    /** Run a per-service action, then re-sync the list and the shared count. */
    const runAction = useCallback(
        async (run: () => Promise<void>) => {
            try {
                await run();
                await reload();
                void refreshUptime();
            } catch {
                setError('Action impossible.');
            }
        },
        [reload]
    );

    /** Le service réglé dans `ServiceDialog` ; `service: null` = un ajout. `null` = fermé. */
    const [dialog, setDialog] = useState<{ service: UptimeService | null } | null>(null);

    const selected = selectedId === null ? null : (services.find((s) => s.id === selectedId) ?? null);
    const downCount = services.filter((s) => s.enabled && s.status === 'down').length;

    /**
     * Apply a drop: reorder locally first so the row lands where it was dropped
     * with no round trip, then persist. A failure rolls back by re-reading the
     * server, which is the only order that is actually true.
     */
    const handleReorder = useCallback(
        (ids: number[]) => {
            setServices((prev) => {
                const byId = new Map(prev.map((s) => [s.id, s]));
                return ids.flatMap((id) => byId.get(id) ?? []);
            });
            ws.send('uptime.reorder', { ids }).catch(() => {
                setError('Réorganisation impossible.');
                void reload();
            });
        },
        [workspaceId, reload]
    );

    return (
        <div className={styles.feature}>
            {selected ? (
                <ServiceDetail
                    service={selected}
                    onBack={() => setSelectedId(null)}
                    onEdit={() => setDialog({ service: selected })}
                    onCheckNow={() =>
                        void runAction(async () => {
                            await ws.send('uptime.checkNow', { id: selected.id });
                        })
                    }
                />
            ) : (
                <>
                    <div className={styles.toolbar}>
                        <p className={styles.headline}>
                            {loading
                                ? 'Chargement…'
                                : services.length === 0
                                  ? 'Aucun service surveillé'
                                  : downCount > 0
                                    ? `${downCount} service${downCount > 1 ? 's' : ''} hors ligne`
                                    : 'Tous les services répondent'}
                        </p>
                        <div className={styles.toolbarActions}>
                            <FeatureSettingsButton scope={{ kind: 'feature', feature: 'uptime' }} />
                            <Button icon='plus' onClick={() => setDialog({ service: null })}>
                                Ajouter un service
                            </Button>
                        </div>
                    </div>

                    {error && <p className={styles.error}>{error}</p>}

                    {!loading && services.length === 0 ? (
                        <p className={styles.empty}>
                            Ajoutez une URL à surveiller : DevEye la teste en continu, garde l’historique complet et
                            vous prévient dès qu’elle tombe.
                        </p>
                    ) : (
                        <ServiceList
                            services={services}
                            onOpen={(service) => setSelectedId(service.id)}
                            onEdit={(service) => setDialog({ service })}
                            onReorder={handleReorder}
                            onDragStateChange={(active) => {
                                dragging.current = active;
                            }}
                        />
                    )}
                </>
            )}

            <ServiceDialog
                open={dialog !== null}
                service={dialog?.service ?? null}
                onClose={() => setDialog(null)}
                onSaved={() => {
                    setDialog(null);
                    void reload();
                    void refreshUptime();
                }}
                onRemoved={
                    dialog?.service
                        ? () => {
                              setDialog(null);
                              setSelectedId(null);
                              void reload();
                              void refreshUptime();
                          }
                        : undefined
                }
            />
        </div>
    );
}
