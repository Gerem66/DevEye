import type { ReactNode } from 'react';
import { motion } from 'framer-motion';

import styles from './Hint.module.css';

/**
 * Où se pose la bulle : au-dessus d'une pastille d'un coin bas de l'écran, ou
 * sous son ancre (un parent en `position: relative`).
 */
export type HintPlacement = 'corner-left' | 'corner-right' | 'below';

const PLACEMENT_CLASS: Record<HintPlacement, string> = {
    'corner-left': styles.cornerLeft,
    'corner-right': styles.cornerRight,
    below: styles.below
};

export interface HintProps {
    title: string;
    children: ReactNode;
    placement: HintPlacement;
    className?: string;
    /** Referme la bulle pour de bon (la croix). */
    onDismiss: () => void;
}

/**
 * Une bulle qui présente un bouton aux nouveaux venus, tant qu'on ne l'a pas
 * écartée. Qui l'affiche et quand : voir `useHint`.
 */
export function Hint({ title, children, placement, className, onDismiss }: HintProps) {
    const rise = placement === 'below' ? -8 : 8;
    return (
        <motion.aside
            className={`${styles.hint} ${PLACEMENT_CLASS[placement]} ${className ?? ''}`}
            role='status'
            initial={{ opacity: 0, y: rise }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ type: 'spring', stiffness: 260, damping: 26, delay: 0.6 }}
        >
            <button type='button' className={styles.close} onClick={onDismiss} aria-label='Ne plus afficher'>
                <span className='icon icon-x' />
            </button>
            <p className={styles.title}>{title}</p>
            <p className={styles.body}>{children}</p>
        </motion.aside>
    );
}

export default Hint;
