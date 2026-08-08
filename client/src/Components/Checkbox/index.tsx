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
 * Une case à cocher aux couleurs du projet.
 *
 * Les cases natives ne se dessinent pas : `accent-color` teinte la coche et rien
 * d'autre, si bien qu'elles gardaient partout le gris du système au milieu de
 * champs en verre. Elles restent pourtant **dans le DOM**, seulement masquées à
 * l'œil : l'état, le focus, la barre d'espace, le clic sur le libellé et
 * l'accessibilité restent ceux du navigateur, et la boîte visible n'est qu'un
 * reflet piloté par `:checked`. Un `<div role="checkbox">` aurait demandé de
 * réécrire tout cela à la main, moins bien.
 *
 * Le libellé accepte du contenu de flux : un titre suivi d'une explication est
 * le cas courant, et il est disposé par la feuille de style plutôt que par
 * chaque appelant.
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
