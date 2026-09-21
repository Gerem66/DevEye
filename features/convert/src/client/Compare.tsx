import type { CSSProperties } from 'react';

import styles from './style.module.css';

interface CompareProps {
    /** L'image d'origine, déjà cadrée comme le résultat. */
    before: React.ReactNode;
    afterUrl: string;
    /** La place du rideau, en pour cent. Tenue par l'appelant : la comparaison peut s'effacer un instant sans la perdre. */
    split: number;
    onSplit: (split: number) => void;
}

/**
 * Avant et après, l'un sur l'autre, séparés par un rideau qu'on déplace. Le
 * rideau est un vrai `<input type='range'>` invisible posé sur l'image : le
 * clavier, le tactile et un lecteur d'écran le manient sans rien de plus.
 */
export function Compare({ before, afterUrl, split, onSplit }: CompareProps) {
    return (
        <div className={styles.compare} style={{ '--split': `${split}%` } as CSSProperties}>
            {before}
            <img className={styles.compareAfter} src={afterUrl} alt='' draggable={false} />
            <span className={styles.compareLine} aria-hidden='true' />
            <span className={`${styles.compareTag} ${styles.compareTagBefore}`} aria-hidden='true'>
                Avant
            </span>
            <span className={`${styles.compareTag} ${styles.compareTagAfter}`} aria-hidden='true'>
                Après
            </span>
            <input
                className={styles.compareRange}
                type='range'
                min={0}
                max={100}
                value={split}
                aria-label='Comparer l’image avant et après conversion'
                aria-valuetext={`${split} % de l’image d’origine visible`}
                onChange={(e) => onSplit(Number(e.target.value))}
            />
        </div>
    );
}
