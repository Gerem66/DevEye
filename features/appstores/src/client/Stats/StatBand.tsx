import { delta, formatDelta, formatRatingDelta } from '../format';
import styles from '../style.module.css';

/** L'écart à la période précédente, déjà écrit, et s'il est une bonne nouvelle. */
export interface StatChange {
    text: string;
    tone: 'good' | 'bad' | 'flat';
}

export interface StatTile {
    key: string;
    label: string;
    value: string;
    /** La définition, au survol : chaque tuile en a une, sinon les autres auraient l'air d'aller de soi. */
    hint: string;
    change?: StatChange | null;
    note?: string;
}

/** Une hausse est une mauvaise nouvelle pour un taux de plantage : `inverted` le dit. */
function toneOf(rounded: number, inverted: boolean): StatChange['tone'] {
    if (rounded === 0) return 'flat';
    return rounded > 0 !== inverted ? 'good' : 'bad';
}

/** L'écart relatif, ou rien sans base de comparaison. */
export function relativeChange(current: number | null, previous: number | null, inverted = false): StatChange | null {
    if (current === null || previous === null) return null;
    const change = delta(current, previous);
    if (change === null) return null;
    return { text: formatDelta(change), tone: toneOf(Math.round(change * 100), inverted) };
}

/** L'écart d'une note, en dixièmes de point. */
export function ratingChange(current: number | null, previous: number | null): StatChange | null {
    if (current === null || previous === null) return null;
    return { text: formatRatingDelta(current - previous), tone: toneOf(Math.round((current - previous) * 10), false) };
}

/** Le bandeau des chiffres d'une période, chacun avec son écart quand la période d'avant est connue. */
export function StatBand({ tiles }: { tiles: readonly StatTile[] }) {
    return (
        <dl className={styles.band}>
            {tiles.map((tile) => (
                <div key={tile.key} className={styles.bandTile} title={tile.hint}>
                    <dt className={styles.bandLabel}>{tile.label}</dt>
                    <dd className={styles.bandValue}>
                        {tile.value}
                        {tile.change && (
                            <span className={styles.bandDelta} data-tone={tile.change.tone}>
                                {tile.change.text}
                            </span>
                        )}
                    </dd>
                    {tile.note && <dd className={styles.bandNote}>{tile.note}</dd>}
                </div>
            ))}
        </dl>
    );
}

export default StatBand;
