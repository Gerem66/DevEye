import styles from './style.module.css';

export interface LoadingVeilProps {
    /** Lu par les lecteurs d'écran, et affiché sous la roue quand il est donné. */
    label?: string;
    /** `top` pour une longue zone défilante : la roue reste en vue. */
    align?: 'center' | 'top';
    /** Apparition retardée d'un quart de seconde : une lecture brève ne fait rien clignoter. */
    delayed?: boolean;
    className?: string;
}

/**
 * Le voile d'une relecture : un calque au-dessus d'une zone, le contenu
 * d'avant lisible dessous, qui ne prend ni clic ni défilement. Se pose en
 * frère de la zone défilante, dans un parent `position: relative` : dans un
 * `overflow: auto`, il partirait avec le défilement. Pour atténuer ce qu'il
 * couvre, `filter: opacity()` sur la zone, jamais `opacity` (framer-motion la
 * possède).
 */
export default function LoadingVeil({ label, align = 'center', delayed = false, className }: LoadingVeilProps) {
    const classes = [styles.veil, align === 'top' && styles.top, delayed && styles.delayed, className]
        .filter(Boolean)
        .join(' ');
    return (
        <div role='status' aria-label={label ?? 'Chargement'} className={classes}>
            <span className={`icon icon-spinner ${styles.spinner}`} aria-hidden='true' />
            {label && <span className={styles.label}>{label}</span>}
        </div>
    );
}
