import { Button } from 'deveye-sdk-client';
import styles from './style.module.css';

interface PaginationProps {
    /** Page courante, à partir de 1. */
    page: number;
    /** Nombre total de pages ; 0 ou 1 = rien à parcourir. */
    pageCount: number;
    disabled?: boolean;
    onGo: (page: number) => void;
}

/** Pages nommées à chaque extrémité. */
const EDGE = 2;
/** Voisines de la page courante nommées. */
const AROUND = 2;
/** En deçà, toutes les pages sont nommées. */
const ALL_UP_TO = 10;

/**
 * Les pages à écrire, `null` pour une coupure : les extrémités et le voisinage
 * de la page courante. Une coupure n'apparaît que si elle cache deux pages.
 */
export function pageSteps(page: number, pageCount: number): (number | null)[] {
    if (pageCount <= ALL_UP_TO) return Array.from({ length: pageCount }, (_, i) => i + 1);

    const keep = new Set<number>();
    for (let i = 1; i <= EDGE; i++) keep.add(i);
    for (let i = pageCount - EDGE + 1; i <= pageCount; i++) keep.add(i);
    for (let i = page - AROUND; i <= page + AROUND; i++) {
        if (i >= 1 && i <= pageCount) keep.add(i);
    }

    const sorted = [...keep].sort((a, b) => a - b);
    const out: (number | null)[] = [];
    let previous = 0;
    for (const value of sorted) {
        if (previous !== 0 && value - previous > 1) {
            // Un seul trou se nomme.
            if (value - previous === 2) out.push(previous + 1);
            else out.push(null);
        }
        out.push(value);
        previous = value;
    }
    return out;
}

export function Pagination({ page, pageCount, disabled, onGo }: PaginationProps) {
    if (pageCount <= 1) return null;

    return (
        <nav className={styles.pager} aria-label='Pages de la table'>
            <Button variant='secondary' onClick={() => onGo(page - 1)} disabled={disabled || page <= 1}>
                Précédent
            </Button>

            <div className={styles.pagerSteps}>
                {pageSteps(page, pageCount).map((step, i) =>
                    step === null ? (
                        <span key={`gap-${i}`} className={styles.pagerGap} aria-hidden='true'>
                            …
                        </span>
                    ) : (
                        <button
                            key={step}
                            type='button'
                            className={step === page ? styles.pagerStepOn : styles.pagerStep}
                            aria-current={step === page ? 'page' : undefined}
                            aria-label={`Page ${step}`}
                            disabled={disabled}
                            onClick={() => onGo(step)}
                        >
                            {step}
                        </button>
                    )
                )}
            </div>

            <Button variant='secondary' onClick={() => onGo(page + 1)} disabled={disabled || page >= pageCount}>
                Suivant
            </Button>
        </nav>
    );
}

export default Pagination;
