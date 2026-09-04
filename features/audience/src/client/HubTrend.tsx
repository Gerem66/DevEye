import { useEffect, useState } from 'react';
import { useResourceVersion } from 'deveye-sdk-client';
import type { AudienceOverview, AudienceSite } from '../contracts/domain';

import { api } from './api';
import { bucketOf } from './format';
import TrendChart from './Stats/TrendChart';
import styles from './style.module.css';

/** La fenêtre du sommaire, la même que celle des cartes qui la surplombent. */
const RANGE = '7d';

interface HubTrendProps {
    site: AudienceSite;
    /** Le panneau mène à la section qui porte la courbe en entier. */
    onOpen: () => void;
}

/**
 * La courbe de fréquentation, en bas du sommaire d'un site.
 *
 * Le sommaire dit ce qui a bougé ; il ne montrait pas à quoi ça ressemble, et
 * trois cartes de chiffres au-dessus d'un espace vide se lisaient comme une
 * page inachevée. C'est la même courbe que la section Fréquentation, sur la
 * même commande : la dupliquer autrement ferait deux dessins d'une seule
 * mesure, qui finiraient par diverger.
 *
 * Elle ne s'affiche que si le site a réellement mesuré quelque chose : un site
 * qui vient d'être déclaré n'a pas de courbe à montrer, il a une balise à
 * coller, et la carte du dessus le dit déjà. Passé ce cap, elle reste là même
 * creuse — une semaine sans visite est une information, pas un panneau à
 * escamoter. Un échec de lecture, lui, ne rend rien : c'est un supplément, pas
 * une donnée qu'on doit à l'écran.
 */
export function HubTrend({ site, onOpen }: HubTrendProps) {
    const [overview, setOverview] = useState<AudienceOverview | null>(null);
    const statsVersion = useResourceVersion('audience.stats');

    useEffect(() => {
        if (site.lastEventAt === null) {
            setOverview(null);
            return;
        }
        let cancelled = false;
        api.send('audience.overview', { siteId: site.id, range: RANGE })
            .then((res) => {
                if (!cancelled) setOverview(res);
            })
            .catch(() => {
                // Lecture d'appoint : le sommaire se lit sans elle.
            });
        return () => {
            cancelled = true;
        };
    }, [site.id, site.lastEventAt, statsVersion]);

    if (site.lastEventAt === null || !overview) return null;

    return (
        <section className={styles.panel}>
            <div className={styles.panelHead}>
                <h3 className={styles.panelTitle}>Fréquentation, 7 derniers jours</h3>
                <button type='button' className={styles.usageLink} onClick={onOpen}>
                    Tout voir
                </button>
            </div>
            <TrendChart
                points={overview.points}
                resolution={overview.resolution}
                from={overview.points[0]?.at ?? 0}
                to={(overview.points[overview.points.length - 1]?.at ?? 0) + 1}
                bucket={bucketOf(overview)}
            />
        </section>
    );
}

export default HubTrend;
