import { useCallback, useEffect, useState } from 'react';
import type { UptimeService } from 'deveye-types';
import { Button, SelectInput } from '@/Components';
import { ws, WsError } from '@/api/ws';
import { useWorkspacePermissions } from '@/stores/workspace';
import { humanizeError } from '../api';
import styles from '../style.module.css';

interface UptimeLinksProps {
    projectId: number;
    canWrite: boolean;
}

/**
 * Les services surveillés que ce projet rattache.
 *
 * Ils vivent dans l'onglet Déploiement, et nulle part ailleurs : c'est
 * l'endroit où l'on se demande si ce qui vient d'être livré tient debout, donc
 * l'endroit où « est-ce en ligne ? » est la question suivante. Un panneau
 * générique posé sur tous les onglets, comme l'ancien « Liens DevEye »,
 * répondait à cette question partout — c'est-à-dire nulle part.
 *
 * **Chaque feature garde ses droits.** Le serveur ne rend que des identifiants ;
 * les noms et les états viennent d'`uptime.list`, appelée au nom de
 * l'utilisateur. Un membre sans accès à Uptime voit donc qu'il y a des services
 * rattachés, sans pouvoir les nommer — plutôt que de les voir disparaître.
 */
export function UptimeLinks({ projectId, canWrite }: UptimeLinksProps) {
    const canReadUptime = useWorkspacePermissions().canFeature('uptime');
    const [serviceIds, setServiceIds] = useState<number[]>([]);
    const [services, setServices] = useState<UptimeService[] | null>(null);
    const [picked, setPicked] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    const load = useCallback(async () => {
        try {
            const res = await ws.send('project.uptimeList', { projectId });
            setServiceIds(res.serviceIds);
            setError(null);
        } catch (e) {
            setError(humanizeError(e, 'Impossible de charger les services rattachés.'));
        }
    }, [projectId]);

    useEffect(() => {
        void load();
    }, [load]);

    // Le catalogue, pour nommer les rattachés et proposer les autres. Un refus
    // de droit n'est pas une erreur à afficher : il dit « tu ne peux pas choisir
    // ici », et la liste retombe sur des identifiants nus.
    useEffect(() => {
        if (!canReadUptime) {
            setServices([]);
            return;
        }
        let alive = true;
        void (async () => {
            try {
                const res = await ws.send('uptime.list', {});
                if (alive) setServices(res.services);
            } catch (e) {
                if (alive) setServices([]);
                if (!(e instanceof WsError && e.code === 'forbidden')) {
                    setError(humanizeError(e, 'Impossible de charger les services surveillés.'));
                }
            }
        })();
        return () => {
            alive = false;
        };
    }, [canReadUptime]);

    const write = async (command: 'project.uptimeLink' | 'project.uptimeUnlink', serviceId: number) => {
        setBusy(true);
        try {
            const res = await ws.send(command, { projectId, serviceId });
            setServiceIds(res.serviceIds);
            setPicked('');
            setError(null);
        } catch (e) {
            setError(humanizeError(e, 'La liaison n’a pas pu être modifiée.'));
        } finally {
            setBusy(false);
        }
    };

    const byId = new Map((services ?? []).map((s) => [s.id, s]));
    const free = (services ?? []).filter((s) => !serviceIds.includes(s.id));

    /** Le point d'état, avec la même sémantique que dans Uptime. */
    const tone = (service: UptimeService | undefined) => {
        if (!service || !service.enabled) return 'neutral';
        if (service.status === 'up') return 'online';
        if (service.status === 'down') return 'down';
        return 'neutral';
    };

    return (
        <section className={styles.uptimeLinks}>
            <h3 className={styles.sectionTitle}>Services surveillés</h3>

            {error && <p className={styles.error}>{error}</p>}

            {serviceIds.length > 0 && (
                <ul className={styles.linkList}>
                    {serviceIds.map((id) => {
                        const service = byId.get(id);
                        return (
                            <li key={id} className={styles.tag}>
                                <span className={styles.uptimeDot} data-tone={tone(service)} aria-hidden='true' />
                                {service?.name ?? `Service #${id}`}
                                {canWrite && (
                                    <button
                                        type='button'
                                        className={styles.tagRemove}
                                        aria-label={`Détacher ${service?.name ?? `le service #${id}`}`}
                                        disabled={busy}
                                        onClick={() => void write('project.uptimeUnlink', id)}
                                    >
                                        <span className='icon icon-x' />
                                    </button>
                                )}
                            </li>
                        );
                    })}
                </ul>
            )}

            {serviceIds.length === 0 && (
                <p className={styles.hint}>
                    Aucun service rattaché. Reliez ce qui surveille l’application déployée, pour lire sa disponibilité
                    ici même.
                </p>
            )}

            {canWrite && canReadUptime && (
                <div className={styles.tagRow}>
                    <SelectInput
                        value={picked}
                        onChange={(e) => setPicked(e.target.value)}
                        disabled={busy || free.length === 0}
                    >
                        <option value=''>
                            {services === null ? 'Chargement…' : free.length === 0 ? 'Rien à rattacher' : 'Choisir…'}
                        </option>
                        {free.map((s) => (
                            <option key={s.id} value={s.id}>
                                {s.name || `Service #${s.id}`}
                            </option>
                        ))}
                    </SelectInput>
                    <Button
                        variant='secondary'
                        disabled={busy || !picked}
                        onClick={() => void write('project.uptimeLink', Number(picked))}
                    >
                        Rattacher
                    </Button>
                </div>
            )}

            {canWrite && !canReadUptime && (
                <span className={styles.hint}>Votre rôle ne donne pas accès à Uptime dans cet espace.</span>
            )}
        </section>
    );
}

export default UptimeLinks;
