import { useEffect, useState } from 'react';
import type { UptimePoint, UptimeResolution, UptimeService } from 'deveye-types';
import { Button } from '@/Components';
import { ws } from '@/api/ws';
import { startTeleport } from '@/stores/live';
import { getActiveWorkspaceId } from '@/stores/workspace';
import { rangeWindow } from '@/Features/Uptime/format';
import { StatusBars } from '@/Features/Uptime/StatusBars';
import deployStyles from '@/Features/Deploy/style.module.css';
import styles from '../style.module.css';

interface UptimeLinkRowProps {
    service: UptimeService;
    canWrite: boolean;
    busy: boolean;
    onUnlink: () => void;
}

/** Le point d'état, avec la même sémantique que dans Uptime. */
function tone(service: UptimeService): 'online' | 'down' | 'neutral' {
    if (!service.enabled) return 'neutral';
    if (service.status === 'up') return 'online';
    if (service.status === 'down') return 'down';
    return 'neutral';
}

/**
 * Un service surveillé, sous la même forme qu'une cible de déploiement : un
 * bloc bordé, pas une puce — c'est ce que montrent déjà Git, Bases de données
 * et Audience pour tout objet d'espace relié à un projet.
 *
 * Le corps ne porte que les barres des dernières 24 h (`StatusBars`, le
 * composant de la feature Uptime lui-même) : latence, incidents et journal
 * restent dans la fiche complète, une porte plus loin — ce bloc ne répond
 * qu'à « est-ce en ligne, et depuis quand ? ».
 */
export function UptimeLinkRow({ service, canWrite, busy, onUnlink }: UptimeLinkRowProps) {
    const [points, setPoints] = useState<UptimePoint[]>([]);
    const [resolution, setResolution] = useState<UptimeResolution>('raw');

    const id = service.id;
    // Bouge à chaque sonde : c'est ce qui rafraîchit les barres sans minuteur.
    const stamp = service.lastCheckedAt;

    useEffect(() => {
        let cancelled = false;
        void (async () => {
            try {
                const res = await ws.send('uptime.history', { id, range: '24h' });
                if (!cancelled) {
                    setPoints(res.points);
                    setResolution(res.resolution);
                }
            } catch {
                // Un aperçu manqué n'est pas une erreur à afficher ici : le nom
                // et le point d'état restent, seules les barres se taisent.
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [id, stamp]);

    const axis = rangeWindow('24h', points);

    return (
        <section className={deployStyles.block}>
            <header className={deployStyles.blockHead}>
                <div className={deployStyles.blockIdent}>
                    <p className={deployStyles.blockName}>
                        <span className={styles.uptimeDot} data-tone={tone(service)} aria-hidden='true' />
                        {service.name}
                    </p>
                    <p className={deployStyles.blockMeta}>{service.url}</p>
                </div>
                <div className={deployStyles.actions}>
                    {/* Le sens qui manquerait sinon : la feature sait mener aux
                        projets d'un service, l'onglet d'un projet doit savoir
                        mener au service. Par la téléportation, comme partout —
                        garde d'accès comprise. Offert même sans droit
                        d'écriture, c'est une navigation. */}
                    <Button
                        variant='secondary'
                        icon='chevrons-right'
                        onClick={() => startTeleport(getActiveWorkspaceId() ?? 0, ['view:uptime', `l1:${service.id}`])}
                    >
                        Ouvrir l’Uptime
                    </Button>
                    {canWrite && (
                        <Button variant='ghost' icon='x' onClick={onUnlink} disabled={busy}>
                            Délier
                        </Button>
                    )}
                </div>
            </header>

            <StatusBars points={points} from={axis.from} to={axis.to} resolution={resolution} />
        </section>
    );
}

export default UptimeLinkRow;
