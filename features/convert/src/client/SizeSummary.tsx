import { formatBytesFr } from 'deveye-sdk-client';

import type { SizeEstimate } from '../contracts/estimate';
import styles from './style.module.css';

interface SizeSummaryProps {
    inputBytes: number;
    estimate: SizeEstimate | null;
    /** Un essai d'encodage est en route : la valeur affichée date d'avant le dernier geste, elle se grise. */
    pending?: boolean;
}

/** Le poids du fichier, avant et après : les deux lignes se lisent l'une sous l'autre, aux mêmes colonnes. */
export function SizeSummary({ inputBytes, estimate, pending }: SizeSummaryProps) {
    const delta = estimate && inputBytes > 0 ? Math.round((1 - estimate.bytes / inputBytes) * 100) : 0;
    return (
        <dl className={styles.sizes} aria-live='polite'>
            <div>
                <dt>Fichier d’origine</dt>
                <dd>{formatBytesFr(inputBytes)}</dd>
            </div>
            <div>
                <dt>Après conversion</dt>
                <dd className={pending ? styles.sizesStale : undefined}>
                    {estimate ? (
                        <>
                            <strong>
                                {estimate.exact ? '' : 'environ '}
                                {formatBytesFr(estimate.bytes)}
                            </strong>
                            {delta >= 5 && <span className={styles.sizesGain}> {delta} % de moins</span>}
                            {delta <= -5 && <span className={styles.sizesLoss}> {-delta} % de plus</span>}
                        </>
                    ) : (
                        <span className={styles.sizesUnknown}>
                            {pending ? 'calcul en cours' : 'connu à la fin de la conversion'}
                        </span>
                    )}
                    {pending && (
                        <span className={`icon icon-spinner ${styles.spin}`} role='img' aria-label='Calcul en cours' />
                    )}
                </dd>
            </div>
        </dl>
    );
}
