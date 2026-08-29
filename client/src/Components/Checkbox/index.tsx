import type { ReactNode } from 'react';
import styles from './style.module.css';

export interface CheckboxProps {
    checked: boolean;
    /** Reçoit l'état **après** le clic — l'appelant n'a pas à lire l'événement. */
    onChange: (checked: boolean) => void;
    /** Le libellé. Absent (une case dans un tableau), `aria-label` devient requis. */
    children?: ReactNode;
    disabled?: boolean;
    /** Nécessaire quand il n'y a pas de libellé visible. */
    'aria-label'?: string;
    /** Posé sur le `<label>`, pour que l'appelant règle sa place dans sa grille. */
    className?: string;
}

/**
 * Une case à cocher aux couleurs du projet (`accent-color` ne teinte que la
 * coche). La case native reste dans le DOM, masquée : état, focus, clavier et
 * accessibilité restent ceux du navigateur, la boîte visible n'est qu'un reflet
 * piloté par `:checked`.
 */
export function Checkbox({ checked, onChange, children, disabled, className, ...aria }: CheckboxProps) {
    return (
        <label className={`${styles.row} ${className ?? ''}`} aria-disabled={disabled || undefined}>
            <input
                type='checkbox'
                className={styles.native}
                checked={checked}
                disabled={disabled}
                aria-label={aria['aria-label']}
                onChange={(e) => onChange(e.target.checked)}
            />
            <span className={styles.box} aria-hidden='true'>
                <span className={`icon icon-v ${styles.mark}`} />
            </span>
            {children !== undefined && <span className={styles.text}>{children}</span>}
        </label>
    );
}

export default Checkbox;
