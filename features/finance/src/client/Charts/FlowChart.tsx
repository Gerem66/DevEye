import { useState } from 'react';
import type { FinanceMonthPoint } from '../../contracts/domain';

import { formatMoney, formatMonth, formatMonthShort } from '../format';
import styles from '../style.module.css';

const W = 720;
const H = 200;
/** Place laissée sous les barres pour les étiquettes de l'axe. */
const PAD_BOTTOM = 22;
/** Part de la largeur d'un mois occupée par sa paire de barres. */
const BAR_RATIO = 0.52;

interface FlowChartProps {
    months: FinanceMonthPoint[];
    currency: string;
}

/**
 * Douze mois d'entrées et de sorties, et la courbe du solde par-dessus.
 * `viewBox` fixe, sans `ResizeObserver` : le SVG se met à l'échelle seul.
 * Deux échelles : les barres sur les flux du mois, la courbe sur le
 * patrimoine (parfois cent fois plus), là pour sa forme. Les mois vides sont
 * dessinés vides, pas sautés.
 */
export function FlowChart({ months, currency }: FlowChartProps) {
    const [hover, setHover] = useState<number | null>(null);

    const plotH = H - PAD_BOTTOM;
    const step = W / Math.max(1, months.length);
    const barW = (step * BAR_RATIO) / 2;

    const maxFlow = Math.max(1, ...months.map((m) => Math.max(m.income, m.expense)));
    const flowY = (value: number) => plotH - (value / (maxFlow * 1.12)) * plotH;

    const balances = months.map((m) => m.balance);
    const minBalance = Math.min(0, ...balances);
    const maxBalance = Math.max(1, ...balances);
    const spread = maxBalance - minBalance || 1;
    // La courbe respire dans le tiers haut du cadre: assez pour que sa pente se
    // lise, assez peu pour ne pas passer devant les barres.
    const balanceY = (value: number) => plotH * 0.1 + (1 - (value - minBalance) / spread) * plotH * 0.55;

    const x = (index: number) => index * step + step / 2;
    const line = months
        .map((m, i) => `${i === 0 ? 'M' : 'L'} ${x(i).toFixed(1)} ${balanceY(m.balance).toFixed(1)}`)
        .join(' ');

    // Une étiquette sur deux au plus: douze noms de mois côte à côte sur 720
    // unités se chevauchent, et aucun n'est alors lisible.
    const labelEvery = months.length > 8 ? 2 : 1;
    const shown = hover === null ? null : months[hover];

    return (
        <figure className={styles.chart}>
            <svg
                viewBox={`0 0 ${W} ${H}`}
                className={styles.chartSvg}
                role='img'
                aria-label='Entrées et sorties par mois'
            >
                <line x1={0} x2={W} y1={plotH} y2={plotH} className={styles.chartAxis} />

                {months.map((month, i) => (
                    <g key={month.month}>
                        <rect
                            x={x(i) - barW - 1}
                            y={flowY(month.income)}
                            width={barW}
                            height={Math.max(0, plotH - flowY(month.income))}
                            rx={2}
                            className={styles.chartBarIn}
                        />
                        <rect
                            x={x(i) + 1}
                            y={flowY(month.expense)}
                            width={barW}
                            height={Math.max(0, plotH - flowY(month.expense))}
                            rx={2}
                            className={styles.chartBarOut}
                        />
                    </g>
                ))}

                <path d={line} className={styles.chartLine} />

                {months.map((month, i) =>
                    i % labelEvery === 0 || i === months.length - 1 ? (
                        <text key={month.month} x={x(i)} y={H - 6} className={styles.chartTick} textAnchor='middle'>
                            {formatMonthShort(month.month)}
                        </text>
                    ) : null
                )}

                {hover !== null && (
                    <line x1={x(hover)} x2={x(hover)} y1={0} y2={plotH} className={styles.chartCursor} />
                )}

                {/* Une bande transparente par mois: le survol vise une colonne
                    entière, et non une barre de six pixels qu'il faudrait
                    chercher à la souris. */}
                {months.map((month, i) => (
                    <rect
                        key={`hit-${month.month}`}
                        x={i * step}
                        y={0}
                        width={step}
                        height={plotH}
                        fill='transparent'
                        onMouseEnter={() => setHover(i)}
                        onMouseLeave={() => setHover(null)}
                    />
                ))}
            </svg>

            {/* La légende porte la valeur survolée: une info-bulle flottante
                demanderait de suivre le pointeur, et sauterait d'un bord à
                l'autre sur les colonnes de rive. */}
            <figcaption className={styles.chartLegend}>
                <span className={styles.legendItem}>
                    <span className={styles.legendSwatch} data-series='in' aria-hidden='true' />
                    {formatMoney(shown ? shown.income : months.reduce((sum, m) => sum + m.income, 0), currency)}
                    <span className={styles.legendNote}>{shown ? 'entrées' : 'entrées sur 12 mois'}</span>
                </span>
                <span className={styles.legendItem}>
                    <span className={styles.legendSwatch} data-series='out' aria-hidden='true' />
                    {formatMoney(shown ? shown.expense : months.reduce((sum, m) => sum + m.expense, 0), currency)}
                    <span className={styles.legendNote}>{shown ? 'sorties' : 'sorties sur 12 mois'}</span>
                </span>
                <span className={styles.legendItem}>
                    <span className={styles.legendSwatch} data-series='balance' aria-hidden='true' />
                    {formatMoney(shown ? shown.balance : (months.at(-1)?.balance ?? 0), currency)}
                    <span className={styles.legendNote}>solde en fin de mois</span>
                </span>
                <span className={styles.legendWhen}>{shown ? formatMonth(shown.month) : 'survolez un mois'}</span>
            </figcaption>
        </figure>
    );
}

export default FlowChart;
