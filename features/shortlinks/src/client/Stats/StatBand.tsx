import type { ShortlinkRange, ShortlinkStats } from '../../contracts/domain';
import { delta, formatCount, formatDelta, RANGE_BEFORE } from '../format';
import styles from '../style.module.css';

interface Tile {
    label: string;
    /** La définition, au survol : sans elle, « visite » et « ouverture » se confondent. */
    hint: string;
    current: number;
    /** `null` : pas de comparaison, la période d'avant ne compte pas cette mesure. */
    previous: number | null;
}

/** Les chiffres de la période, chacun avec son écart à la période d'avant, de même durée. */
export default function StatBand({ stats, range }: { stats: ShortlinkStats; range: ShortlinkRange }) {
    const tiles: Tile[] = [
        {
            label: 'Visites',
            hint: 'Les personnes qui ont suivi le lien, comptées une fois par lien et par jour. C’est ce que compte votre offre.',
            current: stats.totals.visits,
            previous: stats.previous.visits
        },
        {
            label: 'Ouvertures',
            hint: 'Chaque passage par le lien, même répété par la même personne le même jour.',
            current: stats.totals.clicks,
            previous: stats.previous.clicks
        },
        {
            label: 'Robots écartés',
            hint: 'Les aperçus des messageries, les moteurs de recherche et les outils automatiques : ils sont redirigés, mais jamais comptés.',
            current: stats.totals.bots,
            previous: null
        }
    ];

    return (
        <dl className={styles.band}>
            {tiles.map((tile) => {
                const change = tile.previous === null ? null : delta(tile.current, tile.previous);
                const tone = change === null || Math.round(change * 100) === 0 ? 'flat' : change > 0 ? 'up' : 'down';
                return (
                    <div key={tile.label} className={styles.bandTile} title={tile.hint}>
                        <dt className={styles.bandLabel}>{tile.label}</dt>
                        <dd className={styles.bandValue}>
                            {formatCount(tile.current)}
                            {change !== null && (
                                <span className={styles.bandDelta} data-tone={tone}>
                                    {formatDelta(change)}
                                </span>
                            )}
                        </dd>
                        {tile.previous !== null && (
                            <dd className={styles.bandNote}>
                                contre {formatCount(tile.previous)} {RANGE_BEFORE[range]}
                            </dd>
                        )}
                    </div>
                );
            })}
        </dl>
    );
}
