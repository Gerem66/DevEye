import type { AudienceMetrics } from '../../contracts/domain';

import { delta, formatCount, formatDelta, formatDuration, formatPercent } from '../format';
import styles from '../style.module.css';

interface StatBandProps {
    metrics: AudienceMetrics;
    previous: AudienceMetrics;
    /**
     * Le site reconnaît-il ses visiteurs d'une visite à l'autre ? En mode
     * anonyme la tuile « Déjà venus » vaudrait toujours zéro, et un zéro se lit
     * comme une mesure.
     */
    tracksReturning: boolean;
}

/** Une mesure, ce qu'elle vaut, et le sens dans lequel il faut lire son écart. */
interface Tile {
    label: string;
    value: string;
    /**
     * La définition, montrée au survol. Portée par `title` et non par
     * `aria-label`, qui est lu par les lecteurs d'écran mais ne s'affiche pas au
     * survol. Les cinq en ont une : n'expliquer que le plus obscur laisserait
     * croire que les autres vont de soi.
     */
    hint: string;
    current: number;
    previous: number;
    /**
     * `true` quand une hausse est une mauvaise nouvelle. Le taux de rebond est
     * le seul du lot : sans cette distinction, un rebond qui grimpe de dix
     * points s'afficherait en vert.
     */
    inverted?: boolean;
}

/**
 * Le bandeau d'un site : cinq nombres, chacun avec son écart à la période
 * précédente, qui est la moitié de l'information. La période de comparaison est
 * de même longueur et immédiatement antérieure, calculée par le serveur pour
 * que les deux chiffres viennent de la même requête.
 */
export function StatBand({ metrics, previous, tracksReturning }: StatBandProps) {
    const tiles: Tile[] = [
        {
            label: 'Vues',
            hint: 'Pages affichées, rechargements et retours en arrière compris.',
            value: formatCount(metrics.views),
            current: metrics.views,
            previous: previous.views
        },
        {
            label: 'Visiteurs',
            hint:
                'Personnes distinctes, reconnues sans cookie. Un même visiteur qui revient le lendemain ' +
                'compte pour un nouveau.',
            value: formatCount(metrics.visitors),
            current: metrics.visitors,
            previous: previous.visitors
        },
        {
            label: 'Visites',
            hint: 'Passages sur le site. Une nouvelle visite s’ouvre après 30 minutes sans activité.',
            value: formatCount(metrics.sessions),
            current: metrics.sessions,
            previous: previous.sessions
        },
        {
            label: 'Durée moyenne',
            hint:
                'Temps écoulé entre la première et la dernière page d’une visite. Une visite d’une seule ' +
                'page dure donc zéro.',
            value: formatDuration(metrics.avgDurationSeconds),
            current: metrics.avgDurationSeconds,
            previous: previous.avgDurationSeconds
        },
        {
            label: 'Rebond',
            hint:
                'Part des visites qui n’ont vu qu’une seule page, puis sont reparties. Plus il est bas, ' +
                'plus les visiteurs poursuivent leur navigation.',
            value: formatPercent(metrics.bounceRate),
            current: metrics.bounceRate,
            previous: previous.bounceRate,
            inverted: true
        }
    ];

    if (tracksReturning) {
        tiles.splice(2, 0, {
            label: 'Déjà venus',
            hint:
                'Visiteurs qui étaient déjà passés avant cette période. Ne remonte pas au-delà de la ' +
                'conservation du site : quelqu’un dont la dernière visite a expiré repasse pour un nouveau.',
            value: formatCount(metrics.returningVisitors),
            current: metrics.returningVisitors,
            previous: previous.returningVisitors
        });
    }

    return (
        <dl className={styles.band}>
            {tiles.map((tile) => {
                const change = delta(tile.current, tile.previous);
                const tone =
                    change === null || Math.round(change * 100) === 0
                        ? 'flat'
                        : change > 0 === !tile.inverted
                          ? 'up'
                          : 'down';
                return (
                    <div key={tile.label} className={styles.bandTile} title={tile.hint}>
                        <dt className={styles.bandLabel}>{tile.label}</dt>
                        <dd className={styles.bandValue}>
                            {tile.value}
                            {/* Pas d'écart quand la période précédente est vide :
                                « +100 % » sur un site qui démarre serait inventé. */}
                            {change !== null && (
                                <span className={styles.bandDelta} data-tone={tone}>
                                    {formatDelta(change)}
                                </span>
                            )}
                        </dd>
                    </div>
                );
            })}
        </dl>
    );
}

export default StatBand;
