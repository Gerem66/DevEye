import type { ReactNode } from 'react';

import styles from './style.module.css';

interface StepHeaderProps {
    number: number;
    title: string;
    /** Ce que l'étape a retenu, rappelé tant qu'elle est repliée. */
    summary?: string;
    open: boolean;
    /** L'`id` du corps que ce titre ouvre. */
    controls: string;
    onClick: () => void;
}

/** Le titre numéroté d'une étape du formulaire de création : il l'ouvre au clic. */
export function StepHeader({ number, title, summary, open, controls, onClick }: StepHeaderProps) {
    return (
        <h3 className={styles.stepHeading}>
            <button
                type='button'
                className={styles.stepHeader}
                aria-expanded={open}
                aria-controls={controls}
                onClick={onClick}
            >
                <span className={styles.stepNumber} aria-hidden='true'>
                    {number}
                </span>
                <span className={styles.stepLabel}>
                    <span className={styles.stepTitle}>{title}</span>
                    {summary && !open && <span className={styles.stepSummary}>· {summary}</span>}
                </span>
                <i
                    className={`icon icon-chevron ${styles.stepChevron} ${open ? styles.stepChevronOpen : ''}`}
                    aria-hidden='true'
                />
            </button>
        </h3>
    );
}

interface StepBodyProps {
    id: string;
    open: boolean;
    children: ReactNode;
}

/** Le corps repliable d'une étape. Replié, il sort de la tabulation (`inert`). */
export function StepBody({ id, open, children }: StepBodyProps) {
    return (
        <div id={id} className={`${styles.stepReveal} ${open ? styles.stepRevealOpen : ''}`} inert={!open}>
            <div className={styles.stepRevealInner}>
                <div className={`${styles.form} ${styles.stepBody}`}>{children}</div>
            </div>
        </div>
    );
}

interface StepFrameProps extends StepBodyProps {
    /** Faux : le contenu se rend nu, sans titre ni repli (un formulaire à une seule étape). */
    framed: boolean;
    header: ReactNode;
}

/** Une étape entière, ou son seul contenu quand le formulaire n'a pas d'étapes. */
export function StepFrame({ framed, header, id, open, children }: StepFrameProps) {
    if (!framed) return <div className={styles.form}>{children}</div>;
    return (
        <section className={styles.step}>
            {header}
            <StepBody id={id} open={open}>
                {children}
            </StepBody>
        </section>
    );
}
