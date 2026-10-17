import type { ReactNode } from 'react';

import styles from './Security.module.css';

interface SectionProps {
    label: string;
    children: ReactNode;
}

/** Un groupe de protections : son intitulé, puis ses rangées dans une carte. */
export function Section({ label, children }: SectionProps) {
    return (
        <section className={styles.section}>
            <span className={styles.sectionLabel}>{label}</span>
            <div className={styles.card}>{children}</div>
        </section>
    );
}

interface RowProps {
    label: string;
    /** Ce que la protection fait dans son état courant, sous l'intitulé. */
    hint?: ReactNode;
    /** Ouvre l'explication détaillée : le « i » à côté de l'intitulé. */
    onInfo?: () => void;
    /** Une rangée qui précise la protection au-dessus d'elle : en retrait. */
    sub?: boolean;
    /** L'échec du dernier geste, sous l'explication. */
    error?: string | null;
    /** La commande, à droite. */
    children?: ReactNode;
    /** Ce qui s'étend sous la rangée sur toute sa largeur (la liste des navigateurs). */
    below?: ReactNode;
}

/** Une protection : son intitulé et son état à gauche, sa commande à droite. */
export function Row({ label, hint, onInfo, sub, error, children, below }: RowProps) {
    return (
        <div className={sub ? `${styles.row} ${styles.sub}` : styles.row}>
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
