import type { InvoicingTotals } from '../contracts/domain';
import { formatMoney, formatVatRate } from './format';
import styles from './style.module.css';

/**
 * Le pied d'un document : le hors taxe, **une ligne par taux de TVA** (c'est une
 * mention obligatoire, pas une coquetterie), puis le toutes taxes. Et, pour une
 * facture entamée, ce qui a déjà été réglé et ce qui reste.
 */
export interface TotalsProps {
    totals: InvoicingTotals;
    currency: string;
    settledCents?: number;
    remainingCents?: number;
}

export default function Totals({ totals, currency, settledCents = 0, remainingCents }: TotalsProps) {
    return (
        <dl className={styles.totals}>
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

            <div className={`${styles.totalRow} ${styles.totalGross}`}>
                <dt>Total toutes taxes comprises</dt>
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
