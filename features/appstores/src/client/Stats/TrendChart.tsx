import { useId, useState } from 'react';
import type { AppStoresResolution } from '../../contracts/domain';

import { formatPointLabel, formatPointTitle } from '../format';
import styles from '../style.module.css';

const W = 720;
const H_FULL = 180;
/** La hauteur d'une courbe glissée dans un bloc plus petit qu'elle (l'onglet d'un projet). */
const H_COMPACT = 120;
/** Place laissée sous la courbe pour les étiquettes de l'axe. */
const PAD_BOTTOM = 22;
/** Un pic collé au cadre se lit comme coupé. */
const HEADROOM = 1.15;

export interface TrendSeries {
    /** Porté en `data-series` : un store garde sa teinte d'une courbe à l'autre. */
    key: string;
    label: string;
    /** Une valeur par seau de `slots`, `null` là où rien n'est relevé. */
    values: readonly (number | null)[];
    /** Ce que la légende dit hors survol : un total, une moyenne. */
    summary: string;
}

interface TrendChartProps {
    /** Les débuts de seau de toute la fenêtre, vides compris. */
    slots: readonly number[];
    resolution: AppStoresResolution;
    series: readonly TrendSeries[];
    format: (value: number) => string;
    /** Ce que le dessin dit à qui ne le voit pas. */
    label: string;
    title?: string;
    /** Une ligne pointillée et ce qu'elle veut dire : le seuil de Google. */
    threshold?: { value: number; label: string };
    compact?: boolean;
}

/** Les suites de seaux relevés : un trou reste un trou, jamais un zéro dessiné. */
function runsOf(values: readonly (number | null)[]): number[][] {
    const runs: number[][] = [];
    let current: number[] = [];
    values.forEach((value, i) => {
        if (value === null) {
            if (current.length > 0) runs.push(current);
            current = [];
        } else {
            current.push(i);
        }
    });
    if (current.length > 0) runs.push(current);
    return runs;
}

/** Entre la ligne brisée (0) et la cubique monotone pleine (1) : des angles adoucis sans s'arrondir tout à fait. */
const SMOOTHING = 0.6;

/**
 * Le tracé d'une suite de points à pas régulier, en cubique monotone : les
 * angles s'arrondissent sans qu'aucune bosse ne dépasse les valeurs relevées.
 */
function smoothPath(points: readonly (readonly [number, number])[]): string {
    const at = ([px, py]: readonly [number, number]) => `${px.toFixed(1)} ${py.toFixed(1)}`;
    if (points.length < 3) return points.map((point, k) => `${k === 0 ? 'M' : 'L'} ${at(point)}`).join(' ');
    const slopes = points.slice(1).map(([px, py], k) => (py - points[k][1]) / (px - points[k][0] || 1));
    // Une pente nulle aux extrêmes locaux, bornée ailleurs : c'est ce qui interdit le dépassement.
    const tangents = points.map((_, k) => {
        if (k === 0) return slopes[0];
        if (k === points.length - 1) return slopes[k - 1];
        const [before, after] = [slopes[k - 1], slopes[k]];
        if (before * after <= 0) return 0;
        return Math.sign(before) * Math.min(Math.abs(before), Math.abs(after), Math.abs(before + after) / 4) * 2;
    });
    let d = `M ${at(points[0])}`;
    for (let k = 1; k < points.length; k++) {
        const [x0, y0] = points[k - 1];
        const [x1, y1] = points[k];
        const third = (x1 - x0) / 3;
        // La pente du segment donne un trait droit : on n'en tire qu'une part vers la tangente monotone.
        const slope = slopes[k - 1];
        const [t0, t1] = [tangents[k - 1], tangents[k]].map((tangent) => slope + (tangent - slope) * SMOOTHING);
        d += ` C ${at([x0 + third, y0 + third * t0])} ${at([x1 - third, y1 - third * t1])} ${at([x1, y1])}`;
    }
    return d;
}

/**
 * Une courbe par série sur la fenêtre demandée. `viewBox` fixe : le SVG suit
 * son conteneur par mise à l'échelle, sans mesure ni recalcul. La légende
 * porte la valeur survolée plutôt qu'une info-bulle qui suivrait le pointeur.
 */
export function TrendChart({ slots, resolution, series, format, label, title, threshold, compact }: TrendChartProps) {
    const [hover, setHover] = useState<number | null>(null);
    const H = compact ? H_COMPACT : H_FULL;
    const fillId = useId();

    // Le zéro reste dans le cadre, et un jour négatif (des remboursements) passe dessous au lieu d'en sortir.
    const known = series.flatMap((s) => s.values.filter((value): value is number => value !== null));
    const top = Math.max(0, threshold?.value ?? 0, ...known);
    const bottom = Math.min(0, ...known);
    const span = top > bottom ? (top - bottom) * HEADROOM : 1;
    const plotH = H - PAD_BOTTOM;
    const step = W / Math.max(1, slots.length);
    const x = (index: number) => index * step + step / 2;
    const y = (value: number) => plotH - ((value - bottom) / span) * plotH;
    const base = y(0);

    /** Une étiquette sur six au plus, la dernière toujours, sans qu'elle chevauche sa voisine. */
    const every = Math.max(1, Math.ceil(slots.length / 6));
    const ticked = (i: number) => i === slots.length - 1 || (i % every === 0 && slots.length - 1 - i >= every / 2);

    const pathOf = (values: readonly (number | null)[], run: number[]) =>
        smoothPath(run.map((i) => [x(i), y(values[i] ?? 0)] as const));

    // Une aire sous une seule série ; à deux, elles se brouilleraient l'une l'autre.
    const area = series.length === 1 ? series[0] : null;

    return (
        <figure className={styles.chart}>
            {title && <p className={styles.chartTitle}>{title}</p>}
            <svg viewBox={`0 0 ${W} ${H}`} className={styles.chartSvg} role='img' aria-label={label}>
                {area && (
                    <defs>
                        <linearGradient id={fillId} x1='0' y1='0' x2='0' y2='1'>
                            <stop offset='0%' className={styles.chartStop} data-series={area.key} stopOpacity='0.26' />
                            <stop offset='100%' className={styles.chartStop} data-series={area.key} stopOpacity='0' />
                        </linearGradient>
                    </defs>
                )}

                {area &&
                    runsOf(area.values)
                        .filter((run) => run.length > 1)
                        .map((run) => (
                            <path
                                key={`area-${run[0]}`}
                                d={`${pathOf(area.values, run)} L ${x(run[run.length - 1]).toFixed(1)} ${base.toFixed(1)} L ${x(run[0]).toFixed(1)} ${base.toFixed(1)} Z`}
                                fill={`url(#${fillId})`}
                            />
                        ))}

                {threshold && (
                    <line
                        x1={0}
                        x2={W}
                        y1={y(threshold.value)}
                        y2={y(threshold.value)}
                        className={styles.chartThreshold}
                    />
                )}

                {series.map((s) =>
                    runsOf(s.values).map((run) =>
                        run.length === 1 ? (
                            <circle
                                key={`${s.key}-${run[0]}`}
                                cx={x(run[0])}
                                cy={y(s.values[run[0]] ?? 0)}
                                r={2.5}
                                className={styles.chartDot}
                                data-series={s.key}
                            />
                        ) : (
                            <path
                                key={`${s.key}-${run[0]}`}
                                d={pathOf(s.values, run)}
                                className={styles.chartLine}
                                data-series={s.key}
                            />
                        )
                    )
                )}

                {slots.map((at, i) =>
                    ticked(i) ? (
                        <text key={at} x={x(i)} y={H - 6} className={styles.chartTick} textAnchor='middle'>
                            {formatPointLabel(at)}
                        </text>
                    ) : null
                )}

                {hover !== null && (
                    <>
                        <line x1={x(hover)} x2={x(hover)} y1={0} y2={plotH} className={styles.chartCursor} />
                        {series.map((s) => {
                            const value = s.values[hover];
                            return value === null || value === undefined ? null : (
                                <circle
                                    key={`hover-${s.key}`}
                                    cx={x(hover)}
                                    cy={y(value)}
                                    r={3.5}
                                    className={styles.chartDot}
                                    data-series={s.key}
                                />
                            );
                        })}
                    </>
                )}

                {/* Une bande par seau : le survol vise une colonne entière, pas un point de deux pixels. */}
                {slots.map((at, i) => (
                    <rect
                        key={`hit-${at}`}
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

            <figcaption className={styles.chartLegend}>
                {series.map((s) => {
                    const value = hover === null ? null : s.values[hover];
                    return (
                        <span key={s.key} className={styles.legendItem}>
                            <span className={styles.legendSwatch} data-series={s.key} aria-hidden='true' />
                            <span className={styles.legendLabel}>{s.label}</span>
                            <span className={styles.legendValue}>
                                {hover === null
                                    ? s.summary
                                    : value === null || value === undefined
                                      ? 'non relevé'
                                      : format(value)}
                            </span>
                        </span>
                    );
                })}
                {threshold && (
                    <span className={styles.legendItem}>
                        <span className={styles.legendThreshold} aria-hidden='true' />
                        <span className={styles.legendLabel}>{threshold.label}</span>
                    </span>
                )}
                <span className={styles.legendWhen}>
                    {hover === null ? 'survolez la courbe' : formatPointTitle(slots[hover], resolution)}
                </span>
            </figcaption>
        </figure>
    );
}

export default TrendChart;
