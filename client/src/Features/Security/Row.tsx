import type { ReactNode } from 'react';

import ErrorNote, { type ErrorNoteInput } from '@/Components/ErrorNote';

import styles from './Security.module.css';

interface SectionProps {
    title: string;
    /** Ce que le groupe couvre, en une phrase, sous son titre. */
    description: string;
    /** Les protections du groupe en place, sur celles qu'il compte (le même compte que le score du Profil). */
    active: number;
    total: number;
    children: ReactNode;
}

/**
 * Un groupe de protections : une carte, son titre et son propos en tête, son
 * bouclier à droite (vert quand tout est en place, orange sinon), ses rangées
 * dessous.
 */
export function Section({ title, description, active, total, children }: SectionProps) {
    const complete = active >= total;
    return (
        <section className={styles.card}>
            <header className={styles.cardHead}>
                <div className={styles.cardHeadText}>
                    <h3 className={styles.cardTitle}>{title}</h3>
                    <p className={styles.cardText}>{description}</p>
                </div>
                <div
                    className={`${styles.cardStatus} ${complete ? styles.cardStatusOn : styles.cardStatusOff}`}
                    role='img'
                    aria-label={`${active} protection${active > 1 ? 's' : ''} sur ${total}`}
                >
                    <span className={styles.cardCount}>
                        {active} / {total}
                    </span>
                    <span className={styles.cardShield}>
                        <span className='icon icon-shield' />
                    </span>
                </div>
            </header>
            <div className={styles.rows}>{children}</div>
        </section>
    );
}

interface RowProps {
    label: string;
    /** L'icône de la rangée (voir icons.css), en tuile devant l'intitulé. */
    icon?: string;
    /**
     * La couleur de la tuile dit l'état : accent quand la protection est en
     * place, orange quand un réglage ne compte pas ; rien pour une rangée
     * d'action sans état (codes de secours, navigateurs) ou une protection
     * éteinte.
     */
    tone?: 'accent' | 'warning';
    /** Ce que la protection fait dans son état courant, sous l'intitulé. */
    hint?: ReactNode;
    /** Ouvre l'explication détaillée : le « i » à côté de l'intitulé. */
    onInfo?: () => void;
    /** Une rangée qui précise la protection au-dessus d'elle. */
    sub?: boolean;
    /** L'échec du dernier geste, sous l'explication. */
    error?: ErrorNoteInput | null;
    /** La commande, à droite. */
    children?: ReactNode;
    /** Ce qui s'étend sous la rangée sur toute sa largeur (la liste des navigateurs). */
    below?: ReactNode;
}

/** Une protection : sa tuile, son intitulé et son état à gauche, sa commande à droite. */
export function Row({ label, icon, tone, hint, onInfo, sub, error, children, below }: RowProps) {
    const toneClass = tone === 'accent' ? styles.rowIconAccent : tone === 'warning' ? styles.rowIconWarning : '';
    return (
        <div className={sub ? `${styles.row} ${styles.sub}` : styles.row}>
            {icon && (
                <span className={`${styles.rowIcon} ${toneClass}`} aria-hidden>
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
                <ErrorNote note={error ?? null} />
            </div>
            {children && <div className={styles.rowValue}>{children}</div>}
            {below}
        </div>
    );
}
