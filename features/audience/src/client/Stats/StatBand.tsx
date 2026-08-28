import type { AudienceMetrics } from '../../contracts/domain';

import { delta, formatCount, formatDelta, formatDuration, formatPercent } from '../format';
import styles from '../style.module.css';

interface StatBandProps {
    metrics: AudienceMetrics;
    previous: AudienceMetrics;
    /**
     * Le site reconnaît-il ses visiteurs d'une visite à l'autre ?
     *
     * En mode anonyme la tuile « Déjà venus » vaudrait toujours zéro, et un
     * zéro se lit comme une mesure. Mieux vaut ne pas montrer une case que
     * montrer une case qui ment.
     */
    tracksReturning: boolean;
}

/** Une mesure, ce qu'elle vaut, et le sens dans lequel il faut lire son écart. */
interface Tile {
    label: string;
    value: string;
    /**
     * La définition, montrée au survol.
     *
     * Portée par `title` et non par `aria-label` : le second est lu par les
     * lecteurs d'écran mais **ne s'affiche pas** au survol, alors que c'est
     * précisément ce qu'on veut ici. `title` fait les deux.
     *
     * Les cinq en ont une, pas seulement « Rebond ». « Visiteurs » et
     * « Visites » sont exactement le même piège — deux mots proches pour deux
     * choses différentes — et n'expliquer que le plus obscur laisserait croire
     * que les autres vont de soi.
     */
    hint: string;
    current: number;
    previous: number;
    /**
     * `true` quand une hausse est une **mauvaise** nouvelle.
     *
     * Le taux de rebond est le seul du lot. Sans cette distinction, un rebond
     * qui grimpe de dix points s'afficherait en vert, ce qui est exactement le
     * contraire de ce qu'il faut comprendre.
     */
    inverted?: boolean;
}

/**
 * Le bandeau d'un site : cinq nombres, chacun avec son écart à la période
 * précédente.
 *
 * L'écart est la moitié de l'information. « 1 240 vues » ne dit pas s'il faut
 * regarder de plus près ; « 1 240 vues, +18 % » le dit. La période de
 * comparaison est de même longueur et immédiatement antérieure — c'est le
 * serveur qui la calcule, pour que les deux chiffres viennent de la même
 * requête et ne puissent pas diverger.
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
                            {/* Pas d'écart affiché quand la période précédente
                                est vide : « +100 % » sur un site qui démarre
                                serait une information inventée. */}
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
