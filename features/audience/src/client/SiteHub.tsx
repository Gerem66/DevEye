import { useResource, useResourceVersion } from 'deveye-sdk-client';
import type { AudienceSite, AudienceSummary } from '../contracts/domain';

import { api } from './api';
import { formatAgo, formatCount, formatPercent } from './format';
import SectionCard from './SectionCard';
import styles from './style.module.css';

export type SiteSection = 'traffic' | 'funnels' | 'forms';

interface SiteHubProps {
    site: AudienceSite;
    onOpen: (section: SiteSection) => void;
}

/**
 * Le sommaire d'un site : trois cartes, trois lectures qui ne répondent pas à
 * la même question. Empiler les trois écrans complets sur une seule page les
 * rendrait tous illisibles, et le sommaire dit surtout lequel a bougé.
 *
 * Les trois cartes sont toujours là, y compris sur un site qui n'a jamais rien
 * mesuré : un site statique peut ne poser aucune balise et ne se servir que de
 * ses formulaires, et cacher la carte Retours lui fermerait la porte.
 */
export function SiteHub({ site, onOpen }: SiteHubProps) {
    // La ressource des retours change sans que les statistiques bougent (et
    // l'inverse) : les deux doivent rouvrir ce sommaire.
    const formsVersion = useResourceVersion('audience.forms');
    const { data, error } = useResource<AudienceSummary>(
        'audience.stats',
        () => api.send('audience.summary', { siteId: site.id }),
        'Impossible de charger ce site.',
        [site.id, formsVersion]
    );

    if (!data) return <p className={error ? styles.error : styles.empty}>{error ?? 'Chargement…'}</p>;

    return (
        <div className={styles.hub}>
            <SectionCard
                title='Fréquentation'
                empty={site.lastEventAt === null ? 'Aucune mesure reçue. Collez la balise pour démarrer.' : undefined}
                figures={[
                    { value: formatCount(data.traffic.views24h), label: 'vues (24 h)' },
                    { value: formatCount(data.traffic.visitors24h), label: 'visiteurs (24 h)' }
                ]}
                onOpen={() => onOpen('traffic')}
            >
                <Spark days={data.traffic.days} />
            </SectionCard>

            <SectionCard
                title='Entonnoirs'
                empty={
                    data.funnels.count === 0 ? 'Aucun entonnoir. Composez-en un à partir des signaux reçus.' : undefined
                }
                figures={
                    data.funnels.first
                        ? [
                              { value: formatPercent(data.funnels.first.rate), label: data.funnels.first.name },
                              { value: formatCount(data.funnels.count), label: 'définis' }
                          ]
                        : [{ value: formatCount(data.funnels.count), label: 'définis' }]
                }
                onOpen={() => onOpen('funnels')}
            />

            <SectionCard
                title='Retours'
                empty={data.feedback.forms === 0 ? 'Aucun formulaire. Branchez-en un depuis « Installer ».' : undefined}
                figures={[
                    { value: formatCount(data.feedback.submissions), label: 'reçus' },
                    { value: formatCount(data.feedback.last7d), label: '7 derniers jours' },
                    { value: formatCount(data.feedback.forms), label: 'formulaires' }
                ]}
                onOpen={() => onOpen('forms')}
            >
                {data.feedback.lastAt !== null && (
                    <span className={styles.sectionFoot}>Dernier {formatAgo(data.feedback.lastAt)}</span>
                )}
            </SectionCard>
        </div>
    );
}

/**
 * Sept jours de vues, en barres. Aucune échelle ni axe : à cette taille ils
 * seraient illisibles, et la carte ne promet qu'une silhouette. Le serveur rend
 * les sept jours, creux compris.
 */
function Spark({ days }: { days: { day: number; views: number }[] }) {
    if (days.length === 0) return null;
    const max = Math.max(1, ...days.map((d) => d.views));
    return (
        <span className={styles.spark} aria-hidden='true'>
            {days.map((d) => (
                <span key={d.day} className={styles.sparkBar} style={{ height: `${(d.views / max) * 100}%` }} />
            ))}
        </span>
    );
}

export default SiteHub;
