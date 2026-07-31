import { useCallback, useEffect, useMemo, useState } from 'react';

import { ws } from '@/api/ws';
import Button from '@/Components/Button';
import { OpenPopup } from '@/Components/Popup';
import { refreshUptime } from '@/stores/uptime';

import NotificationsPopup, { NOTIFICATIONS_POPUP } from './NotificationsPopup';
import ServiceCard from './ServiceCard';
import ServiceDetail from './ServiceDetail';
import ServicePopup, { SERVICE_POPUP, type ServicePopupResult } from './ServicePopup';
import styles from './style.module.css';

import type { UptimeService } from 'deveye-types';
import type { FeatureProps } from '../types';

/** Cadence the open list re-reads the server at — probes happen without us. */
const REFRESH_MS = 20_000;

/** Failing services first, then the never-tested, then the healthy ones. */
const STATUS_RANK: Record<UptimeService['status'], number> = { down: 0, unknown: 1, up: 2 };

function byUrgency(a: UptimeService, b: UptimeService): number {
    // A paused service can't be "down" in any actionable sense — sink it below
    // the live ones whatever its last known status was.
    if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
    const rank = STATUS_RANK[a.status] - STATUS_RANK[b.status];
    return rank !== 0 ? rank : a.id - b.id;
}

export default function Uptime({ workspace }: FeatureProps) {
    const [services, setServices] = useState<UptimeService[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [selectedId, setSelectedId] = useState<number | null>(null);
    /** Ids with a probe or a pause/resume in flight (their buttons are disabled). */
    const [busy, setBusy] = useState<ReadonlySet<number>>(new Set());

    const workspaceId = workspace.id;

    const reload = useCallback(async () => {
        try {
            const res = await ws.send('uptime.list', { workspaceId });
            setServices(res.services);
            setError(null);
        } catch {
            setError('Chargement impossible.');
        } finally {
            setLoading(false);
        }
    }, [workspaceId]);

    // Reload on open, whenever the socket (re)connects, and on a timer: the
    // server probes in the background, so the list ages on its own.
    useEffect(() => {
        void reload();
        const timer = setInterval(() => void reload(), REFRESH_MS);
        const off = ws.onStateChange((s) => {
            if (s === 'open') void reload();
        });
        return () => {
            clearInterval(timer);
            off();
        };
    }, [reload]);

    /** Run a per-service action while flagging it busy, then re-sync everything. */
    const withBusy = useCallback(
        async (id: number, run: () => Promise<void>) => {
            setBusy((prev) => new Set(prev).add(id));
            try {
                await run();
                await reload();
                void refreshUptime();
            } catch {
                setError('Action impossible.');
            } finally {
                setBusy((prev) => {
                    const next = new Set(prev);
                    next.delete(id);
                    return next;
                });
            }
        },
        [reload]
    );

    const openForm = useCallback(
        async (service: UptimeService | null) => {
            const result = await OpenPopup<ServicePopupResult>(SERVICE_POPUP, service);
            if (result === null) return;
            try {
                if (result === 'delete') {
                    if (!service) return;
                    await ws.send('uptime.remove', { workspaceId, id: service.id });
                    setSelectedId(null);
                } else if (service) {
                    await ws.send('uptime.update', { workspaceId, id: service.id, service: result });
                } else {
                    await ws.send('uptime.add', { workspaceId, service: result });
                }
                await reload();
                void refreshUptime();
            } catch {
                setError('Enregistrement impossible.');
            }
        },
        [workspaceId, reload]
    );

    const sorted = useMemo(() => [...services].sort(byUrgency), [services]);
    const selected = selectedId === null ? null : (services.find((s) => s.id === selectedId) ?? null);
    const downCount = services.filter((s) => s.enabled && s.status === 'down').length;

    return (
        <div className={styles.feature}>
            {selected ? (
                <ServiceDetail
                    service={selected}
                    workspaceId={workspaceId}
                    onBack={() => setSelectedId(null)}
                    onEdit={() => void openForm(selected)}
                    onCheckNow={() =>
                        void withBusy(selected.id, async () => {
                            await ws.send('uptime.checkNow', { workspaceId, id: selected.id });
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
                            <Button
                                variant='secondary'
                                icon='mail'
                                onClick={() => void OpenPopup(NOTIFICATIONS_POPUP, true)}
                            >
                                Notifications
                            </Button>
                            <Button icon='plus' onClick={() => void openForm(null)}>
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
                        <div className={styles.list}>
                            {sorted.map((service) => (
                                <ServiceCard
                                    key={service.id}
                                    service={service}
                                    busy={busy.has(service.id)}
                                    onOpen={() => setSelectedId(service.id)}
                                    onEdit={() => void openForm(service)}
                                    onCheckNow={() =>
                                        void withBusy(service.id, async () => {
                                            await ws.send('uptime.checkNow', { workspaceId, id: service.id });
                                        })
                                    }
                                    onToggle={() =>
                                        void withBusy(service.id, async () => {
                                            await ws.send('uptime.setEnabled', {
                                                workspaceId,
                                                id: service.id,
                                                enabled: !service.enabled
                                            });
                                        })
                                    }
                                />
                            ))}
                        </div>
                    )}
                </>
            )}

            <ServicePopup />
            <NotificationsPopup />
        </div>
    );
}
