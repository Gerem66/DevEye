import { useCallback, useEffect, useRef, useState } from 'react';
import {
    Button,
    FeatureSettingsButton,
    humanizeError,
    onResourceChange,
    onSocketOpen,
    PlanPausedNotice,
    useActiveWorkspace,
    useLiveSegment
} from 'deveye-sdk-client';
import type { FeatureViewProps } from '@deveye/types/sdk/client';
import type { UptimeService } from '../contracts/domain';

import { api } from './api';
import ServiceDetail from './ServiceDetail';
import { ServiceDialog } from './ServiceDialog';
import ServiceList from './ServiceList';
import { refreshUptime } from './store';
import styles from './style.module.css';

/** La vue complète : la liste des services, la fiche d'un service, le journal. */
export default function Uptime(_props: FeatureViewProps) {
    const [services, setServices] = useState<UptimeService[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [selectedId, setSelectedId] = useState<number | null>(null);
    /** A row is in flight: the periodic reload must not reshuffle under it. */
    const dragging = useRef(false);

    const workspaceId = useActiveWorkspace()?.id ?? null;

    // Le niveau profond d'Uptime : le service ouvert. La racine `view:uptime`
    // vient de l'accueil ; cette feature n'annonce que le sien, par l'id nu
    // du service, comme toute fiche d'élément.
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
            const res = await api.send('uptime.list', {});
            setServices(res.services);
            setError(null);
        } catch {
            setError('Chargement impossible.');
        } finally {
            setLoading(false);
        }
        // Relu quand l'espace change : la liste est celle d'un espace.
    }, [workspaceId]);

    // Relecture à chaque (re)connexion et quand le sujet `uptime` bouge (une
    // écriture d'un autre membre, une transition d'état du service de fond).
    useEffect(() => {
        const offInvalidate = onResourceChange('uptime.list', () => {
            // Une relecture réordonne la liste sous le pointeur : jamais pendant
            // un glisser-déposer.
            if (!dragging.current) void reload();
        });
        // Tout de suite si la socket est déjà ouverte, puis à chaque reconnexion.
        const off = onSocketOpen(() => void reload());
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
            } catch (e) {
                setError(humanizeError(e, 'Action impossible.'));
            }
        },
        [reload]
    );

    const [addOpen, setAddOpen] = useState(false);

    const selected = selectedId === null ? null : (services.find((s) => s.id === selectedId) ?? null);
    const downCount = services.filter((s) => s.enabled && !s.planPaused && s.status === 'down').length;
    // Un service partagé d'ailleurs relève de l'offre d'un autre compte que celle dont parle le bandeau.
    const planPausedCount = services.filter((s) => s.planPaused && !s.foreign).length;

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
            api.send('uptime.reorder', { ids }).catch(() => {
                setError('Réorganisation impossible.');
                void reload();
            });
        },
        [reload]
    );

    return (
        <div className={styles.feature}>
            {selected ? (
                <ServiceDetail
                    service={selected}
                    onBack={() => setSelectedId(null)}
                    onCheckNow={() =>
                        void runAction(async () => {
                            await api.send('uptime.checkNow', { id: selected.id });
                        })
                    }
                    onAcceptBaseline={() =>
                        void runAction(async () => {
                            await api.send('uptime.acceptBaseline', { id: selected.id });
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
                            <Button icon='plus' onClick={() => setAddOpen(true)}>
                                Ajouter un service
                            </Button>
                        </div>
                    </div>

                    {error && <p className={styles.error}>{error}</p>}
                    <PlanPausedNotice count={planPausedCount} one='service surveillé' many='services surveillés' />

                    {!loading && services.length === 0 ? (
                        <p className={styles.empty}>
                            Ajoutez une URL à surveiller : DevEye la teste en continu, garde l’historique complet et
                            vous prévient dès qu’elle tombe.
                        </p>
                    ) : (
                        <ServiceList
                            services={services}
                            onOpen={(service) => setSelectedId(service.id)}
                            onReorder={handleReorder}
                            onDragStateChange={(active) => {
                                dragging.current = active;
                            }}
                        />
                    )}
                </>
            )}

            <ServiceDialog
                open={addOpen}
                onClose={() => setAddOpen(false)}
                onSaved={() => {
                    setAddOpen(false);
                    void reload();
                    void refreshUptime();
                }}
            />
        </div>
    );
}
