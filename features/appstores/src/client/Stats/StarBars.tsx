import { formatCount, plural } from '../format';
import styles from '../style.module.css';

/** La note d'un avis : cinq étoiles, pleines jusqu'à elle. */
export function Stars({ rating }: { rating: number }) {
    return (
        <span className={styles.stars} role='img' aria-label={`${plural(rating, 'étoile', 'étoiles')} sur 5`}>
            {[1, 2, 3, 4, 5].map((rank) => (
                <span
                    key={rank}
                    className={`icon ${rank <= rating ? `icon-star ${styles.starOn}` : `icon-star-outline ${styles.starOff}`}`}
                    aria-hidden='true'
                />
            ))}
        </span>
    );
}

interface StarBarsProps {
    /** Les avis par note : l'indice 0 compte ceux à une étoile. */
    counts: readonly number[];
}

/** La répartition des avis, cinq étoiles en haut, chaque barre rapportée à la plus longue. */
export function StarBars({ counts }: StarBarsProps) {
    const total = counts.reduce((sum, count) => sum + count, 0);
    const longest = Math.max(1, ...counts);

    return (
        <ul className={styles.starBars}>
            {[5, 4, 3, 2, 1].map((stars) => {
                const count = counts[stars - 1] ?? 0;
                return (
                    <li
                        key={stars}
                        className={styles.starRow}
                        title={`${plural(count, 'avis', 'avis')} à ${plural(stars, 'étoile', 'étoiles')}`}
                    >
                        <span className={styles.starLabel}>
                            {stars}
                            <span className={`icon icon-star ${styles.starGlyph}`} aria-hidden='true' />
                        </span>
                        <span className={styles.starTrack}>
                            <span className={styles.starFill} style={{ width: `${(count / longest) * 100}%` }} />
                        </span>
                        <span className={styles.starCount}>
                            {formatCount(count)}
                            {total > 0 && (
                                <span className={styles.starShare}> · {Math.round((count / total) * 100)} %</span>
                            )}
                        </span>
                    </li>
                );
            })}
        </ul>
    );
}

export default StarBars;
