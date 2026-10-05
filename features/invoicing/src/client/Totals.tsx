import type { InvoicingTotals } from '../contracts/domain';
import { formatMoney, formatVatRate } from './format';
import styles from './style.module.css';

/**
 * Le pied d'un document : le hors taxe, **une ligne par taux de TVA** (c'est une
 * mention obligatoire, pas une coquetterie), puis le toutes taxes. Et, pour une
 * facture entamée, ce qui a déjà été réglé et ce qui reste. En franchise, un
 * seul total, sans ligne de taxe à zéro.
 */
export interface TotalsProps {
    totals: InvoicingTotals;
    currency: string;
    withVat: boolean;
    settledCents?: number;
    remainingCents?: number;
}

export default function Totals({ totals, currency, withVat, settledCents = 0, remainingCents }: TotalsProps) {
    return (
        <dl className={styles.totals}>
            {withVat ? (
                <>
                    <div className={styles.totalRow}>
                        <dt>Total hors taxes</dt>
                        <dd>{formatMoney(totals.netCents, currency)}</dd>
                    </div>

                    {totals.vat.map((share) => (
                        <div key={share.rateBp} className={styles.totalRow}>
                            <dt>
                                TVA {formatVatRate(share.rateBp)} sur {formatMoney(share.netCents, currency)}
                            </dt>
                            <dd>{formatMoney(share.vatCents, currency)}</dd>
                        </div>
                    ))}
                </>
            ) : (
                <div className={styles.totalRow}>
                    <dt>TVA</dt>
                    <dd>Franchise, non applicable</dd>
                </div>
            )}

            <div className={`${styles.totalRow} ${styles.totalGross}`}>
                <dt>{withVat ? 'Total toutes taxes comprises' : 'Total'}</dt>
                <dd>{formatMoney(totals.grossCents, currency)}</dd>
            </div>

            {settledCents > 0 && (
                <>
                    <div className={styles.totalRow}>
                        <dt>Déjà réglé</dt>
                        <dd>{formatMoney(settledCents, currency)}</dd>
                    </div>
                    <div className={`${styles.totalRow} ${styles.totalGross}`}>
                        <dt>Reste à payer</dt>
                        <dd>
                            {formatMoney(remainingCents ?? Math.max(0, totals.grossCents - settledCents), currency)}
                        </dd>
                    </div>
                </>
            )}
        </dl>
    );
}
