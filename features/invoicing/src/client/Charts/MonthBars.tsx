import type { InvoicingDashboard } from '../../contracts/domain';
import { formatMoney } from '../format';
import styles from '../style.module.css';

/**
 * Douze mois de facturé et d'encaissé, en deux barres par mois. Un `viewBox`
 * fixe et aucun observateur de taille : le SVG se met à l'échelle tout seul, et
 * un mois sans rien se dessine vide plutôt que de disparaître, sans quoi la
 * frise mentirait sur le rythme.
 */

const WIDTH = 720;
const HEIGHT = 200;
const FLOOR = 170;
const TOP = 16;

export interface MonthBarsProps {
    months: InvoicingDashboard['months'];
    currency: string;
}

const MONTH_NAMES = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];

function monthLabel(month: string): string {
    return MONTH_NAMES[Number(month.slice(5, 7)) - 1] ?? month;
}

export default function MonthBars({ months, currency }: MonthBarsProps) {
    if (months.length === 0) return null;

    const top = Math.max(...months.map((entry) => Math.max(entry.billedCents, entry.cashedCents)), 1);
    const slot = WIDTH / months.length;
    const width = Math.min(18, slot / 3);
    const height = (cents: number) => Math.max(cents > 0 ? 2 : 0, ((FLOOR - TOP) * cents) / top);

    return (
        <figure className={styles.chart}>
            <figcaption className={styles.chartLegend}>
                <span className={styles.chartKeyBilled}>Facturé</span>
                <span className={styles.chartKeyCashed}>Encaissé</span>
            </figcaption>
            <svg
                viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
                className={styles.chartSvg}
                role='img'
                aria-label={`Facturé et encaissé sur ${months.length} mois`}
            >
                <line x1='0' y1={FLOOR} x2={WIDTH} y2={FLOOR} className={styles.chartAxis} />
                {months.map((entry, index) => {
                    const center = index * slot + slot / 2;
                    const billed = height(entry.billedCents);
                    const cashed = height(entry.cashedCents);
                    return (
                        <g key={entry.month}>
                            <rect
                                x={center - width - 2}
                                y={FLOOR - billed}
                                width={width}
                                height={billed}
                                rx='2'
                                className={styles.chartBilled}
                            >
                                <title>{`${monthLabel(entry.month)} : ${formatMoney(entry.billedCents, currency)} facturés`}</title>
                            </rect>
                            <rect
                                x={center + 2}
                                y={FLOOR - cashed}
                                width={width}
                                height={cashed}
                                rx='2'
                                className={styles.chartCashed}
                            >
                                <title>{`${monthLabel(entry.month)} : ${formatMoney(entry.cashedCents, currency)} encaissés`}</title>
                            </rect>
                            {/* Une étiquette sur deux au-delà de huit mois : au-delà, elles se chevauchent. */}
                            {(months.length <= 8 || index % 2 === 0) && (
                                <text x={center} y={HEIGHT - 8} textAnchor='middle' className={styles.chartLabel}>
                                    {monthLabel(entry.month)}
                                </text>
                            )}
                        </g>
                    );
                })}
            </svg>
        </figure>
    );
}
