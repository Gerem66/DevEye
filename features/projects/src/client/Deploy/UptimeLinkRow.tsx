import { UPTIME_CLIENT_PROVIDER } from '@deveye/types/sdk';
import type { UptimeClientProvider, UptimeLinkedService } from '@deveye/types/sdk/client';
import { Button, moduleClientProvider, openFeature } from 'deveye-sdk-client';
import styles from '../style.module.css';

interface UptimeLinkRowProps {
    service: UptimeLinkedService;
    canWrite: boolean;
    busy: boolean;
    onUnlink: () => void;
}

/** Le point d'état, avec la même sémantique que dans Uptime. */
function tone(service: UptimeLinkedService): 'online' | 'down' | 'neutral' {
    if (!service.enabled) return 'neutral';
    if (service.status === 'up') return 'online';
    if (service.status === 'down') return 'down';
    return 'neutral';
}

/**
 * Un service surveillé, sous la même forme qu'une cible de déploiement : un
 * bloc bordé, pas une puce ; c'est ce que montrent déjà Git, Bases de données
 * et Audience pour tout objet d'espace relié à un projet.
 *
 * Le corps porte les barres des dernières 24 h et, en face de leur légende, la
 * disponibilité sur les trois fenêtres usuelles (`StatusBars` et `Ratios`, les
 * composants du module Uptime eux-mêmes, lus par son contrat client
 * `UPTIME_CLIENT_PROVIDER` : cet écran n'importe pas le module) : latence,
 * incidents et journal restent dans la fiche complète, une porte plus loin.
 * Ce bloc ne répond qu'à « est-ce en ligne, depuis quand, et à quel prix sur
 * la durée ? ». Module absent, il le dit à la place des barres.
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
 * Les barres disent « quand », les pourcentages disent « combien ». Les
 * seconds se lisent en face de la légende parce qu'ils la chiffrent : sans
 * eux, un incident d'une heure et un incident d'un jour se ressemblent à cette
 * échelle. Ils viennent de la liste du module, déjà chargée par la section :
 * aucune requête de plus. Un composant à part parce que le hook d'historique
 * est celui du module, et ne s'appelle que si le module est là.
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
