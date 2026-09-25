import { UPTIME_CLIENT_PROVIDER } from '@deveye/types/sdk';
import type { UptimeClientProvider, UptimeLinkedService } from '@deveye/types/sdk/client';
import { Button, moduleClientProvider, openFeature, PlanPausedBadge } from 'deveye-sdk-client';
import styles from '../style.module.css';

interface UptimeLinkRowProps {
    service: UptimeLinkedService;
    canWrite: boolean;
    busy: boolean;
    onUnlink: () => void;
}

/** Le point d'état, avec la même sémantique que dans Uptime. */
function tone(service: UptimeLinkedService): 'online' | 'down' | 'neutral' {
    if (!service.enabled || service.planPaused) return 'neutral';
    if (service.status === 'up') return 'online';
    if (service.status === 'down') return 'down';
    return 'neutral';
}

/**
 * Un service surveillé, en bloc bordé comme tout objet d'espace relié à un
 * projet. Il ne répond qu'à « est-ce en ligne, depuis quand, à quel prix sur la
 * durée » : les barres des dernières 24 h et la disponibilité sur les trois
 * fenêtres, rendues par les composants du module Uptime
 * (`UPTIME_CLIENT_PROVIDER`, jamais un import). Latence, incidents et journal
 * restent dans la fiche complète.
 */
export function UptimeLinkRow({ service, canWrite, busy, onUnlink }: UptimeLinkRowProps) {
    const uptime = moduleClientProvider<UptimeClientProvider>(UPTIME_CLIENT_PROVIDER);

    return (
        <section className={styles.block}>
            <header className={styles.blockHead}>
                <div className={styles.blockIdent}>
                    <p className={styles.blockName}>
                        <span className={styles.uptimeDot} data-tone={tone(service)} aria-hidden='true' />
                        {service.name}
                        {service.planPaused && <PlanPausedBadge />}
                    </p>
                    <p className={styles.blockMeta}>{service.url}</p>
                </div>
                <div className={styles.actions}>
                    {/* Le sens qui manquerait sinon : la feature sait mener aux
                        projets d'un service, l'onglet d'un projet doit savoir
                        mener au service. Par la téléportation, comme partout,
                        garde d'accès comprise. Offert même sans droit
                        d'écriture, c'est une navigation. */}
                    <Button variant='secondary' icon='chevrons-right' onClick={() => openFeature('uptime', service.id)}>
                        Ouvrir l’Uptime
                    </Button>
                    {canWrite && (
                        <Button variant='ghost' icon='x' onClick={onUnlink} disabled={busy}>
                            Délier
                        </Button>
                    )}
                </div>
            </header>

            {uptime ? (
                <LinkedStrip uptime={uptime} service={service} />
            ) : (
                <p className={styles.hint}>Le module Uptime n’est pas installé.</p>
            )}
        </section>
    );
}

/**
 * Les pourcentages en face de la légende : à cette échelle, un incident d'une
 * heure et un d'un jour se ressemblent sans eux. Ils viennent de la liste déjà
 * chargée par la section, sans requête de plus. Composant à part parce que le
 * hook d'historique est celui du module, appelé seulement s'il est là.
 */
function LinkedStrip({ uptime, service }: { uptime: UptimeClientProvider; service: UptimeLinkedService }) {
    const { points, resolution, axis } = uptime.useServiceHistory(service.id, service.lastCheckedAt);
    const { StatusBars, Ratios } = uptime;
    return (
        <StatusBars
            points={points}
            from={axis.from}
            to={axis.to}
            resolution={resolution}
            trailing={<Ratios service={service} compact />}
        />
    );
}

export default UptimeLinkRow;
