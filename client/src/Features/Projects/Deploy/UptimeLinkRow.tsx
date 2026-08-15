import type { UptimeService } from 'deveye-types';
import { Button } from '@/Components';
import { startTeleport } from '@/stores/live';
import { getActiveWorkspaceId } from '@/stores/workspace';
import { Ratios } from '@/Features/Uptime/Ratios';
import { StatusBars } from '@/Features/Uptime/StatusBars';
import { useServiceHistory } from '@/Features/Uptime/useServiceHistory';
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
 * Le corps porte les barres des dernières 24 h et, en face de leur légende, la
 * disponibilité sur les trois fenêtres usuelles (`StatusBars` et `Ratios`, les
 * composants de la feature Uptime eux-mêmes) : latence, incidents et journal
 * restent dans la fiche complète, une porte plus loin — ce bloc ne répond
 * qu'à « est-ce en ligne, depuis quand, et à quel prix sur la durée ? ».
 */
export function UptimeLinkRow({ service, canWrite, busy, onUnlink }: UptimeLinkRowProps) {
    const { points, resolution, axis } = useServiceHistory(service.id, service.lastCheckedAt);

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

            {/* Les barres disent « quand », les pourcentages disent « combien ».
                Les seconds se lisent en face de la légende parce qu'ils la
                chiffrent : sans eux, un incident d'une heure et un incident d'un
                jour se ressemblent à cette échelle. Ils viennent d'`uptime.list`,
                déjà chargée par la section — aucune requête de plus. */}
            <StatusBars
                points={points}
                from={axis.from}
                to={axis.to}
                resolution={resolution}
                trailing={<Ratios service={service} compact />}
            />
        </section>
    );
}

export default UptimeLinkRow;
