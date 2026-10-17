import { useState, type ReactNode } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';

import styles from './Security.module.css';

interface SectionProps {
    title: string;
    /** Ce que le groupe couvre, en une phrase, sous son titre. */
    description: string;
    children: ReactNode;
}

/** Un groupe de protections : une carte, son titre et son propos en tête, ses rangées dessous. */
export function Section({ title, description, children }: SectionProps) {
    return (
        <section className={styles.card}>
            <header className={styles.cardHead}>
                <h3 className={styles.cardTitle}>{title}</h3>
                <p className={styles.cardText}>{description}</p>
            </header>
            <div className={styles.rows}>{children}</div>
        </section>
    );
}

const REVEAL = { duration: 0.25, ease: [0.22, 1, 0.36, 1] } as const;

interface RevealProps {
    open: boolean;
    children: ReactNode;
}

/**
 * Les rangées qui n'ont de sens que la protection au-dessus en place : elles
 * se déplient avec elle et se replient quand elle s'éteint. Le débordement
 * n'est masqué que pendant le geste, pour ne pas rogner le liseré de focus
 * d'une commande au repos.
 */
export function Reveal({ open, children }: RevealProps) {
    const reduced = useReducedMotion() === true;
    const [settled, setSettled] = useState(true);
    return (
        <AnimatePresence initial={false}>
            {open && (
                <motion.div
                    style={{ overflow: settled ? 'visible' : 'hidden' }}
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={reduced ? { duration: 0 } : REVEAL}
                    onAnimationStart={() => setSettled(false)}
                    onAnimationComplete={() => setSettled(true)}
                >
                    {children}
                </motion.div>
            )}
        </AnimatePresence>
    );
}

interface RowProps {
    label: string;
    /** L'icône de la protection (voir icons.css), en tuile devant l'intitulé. */
    icon?: string;
    /** La protection est en place : sa tuile prend la couleur d'accent. */
    active?: boolean;
    /** Ce que la protection fait dans son état courant, sous l'intitulé. */
    hint?: ReactNode;
    /** Ouvre l'explication détaillée : le « i » à côté de l'intitulé. */
    onInfo?: () => void;
    /** Une rangée qui précise la protection au-dessus d'elle : sans tuile, alignée sur son texte. */
    sub?: boolean;
    /** L'échec du dernier geste, sous l'explication. */
    error?: string | null;
    /** La commande, à droite. */
    children?: ReactNode;
    /** Ce qui s'étend sous la rangée sur toute sa largeur (la liste des navigateurs). */
    below?: ReactNode;
}

/** Une protection : sa tuile, son intitulé et son état à gauche, sa commande à droite. */
export function Row({ label, icon, active, hint, onInfo, sub, error, children, below }: RowProps) {
    return (
        <div className={sub ? `${styles.row} ${styles.sub}` : styles.row}>
            {icon && (
                <span className={active ? `${styles.rowIcon} ${styles.rowIconOn}` : styles.rowIcon} aria-hidden>
                    <span className={`icon icon-${icon}`} />
                </span>
            )}
            <div className={styles.rowText}>
                <span className={styles.rowLabel}>
                    {label}
                    {onInfo && (
                        <button
                            type='button'
                            className={styles.infoBtn}
                            onClick={onInfo}
                            title='Comment ça fonctionne ?'
                            aria-label={`Comment fonctionne « ${label} » ?`}
                        >
                            <span className='icon icon-info' />
                        </button>
                    )}
                </span>
                {hint && <span className={styles.rowHint}>{hint}</span>}
                {error && (
                    <span className={styles.rowError} role='alert'>
                        {error}
                    </span>
                )}
            </div>
            {children && <div className={styles.rowValue}>{children}</div>}
            {below}
        </div>
    );
}
