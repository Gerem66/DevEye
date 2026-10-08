import type { ButtonHTMLAttributes } from 'react';

import styles from './AddTileButton.module.css';

export interface AddTileButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type' | 'children'> {
    icon: string;
    label: string;
    /** `card` tient dans une case de la grille ; `bar` court sur toute la
     *  largeur, `barThin` en rangée basse. */
    shape?: 'card' | 'bar' | 'barThin';
}

const SHAPE_CLASS = {
    card: styles.card,
    bar: styles.bar,
    barThin: `${styles.bar} ${styles.barThin}`
} as const;

/** Un point d'ajout de l'accueil, en pointillés : le même dessin en
 *  organisation et hors organisation. */
export function AddTileButton({ icon, label, shape = 'card', className, ...rest }: AddTileButtonProps) {
    return (
        <button type='button' className={`${styles.add} ${SHAPE_CLASS[shape]} ${className ?? ''}`} {...rest}>
            <span className={`icon icon-${icon} ${styles.icon}`} aria-hidden='true' />
            <span className={styles.label}>{label}</span>
        </button>
    );
}
