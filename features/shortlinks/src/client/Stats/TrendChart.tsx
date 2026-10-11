import { useId, useState, type KeyboardEvent, type PointerEvent } from 'react';

import type { ShortlinkPoint, ShortlinkStats } from '../../contracts/domain';
import { formatCount, formatPointLabel, formatPointTitle } from '../format';
import { useElementWidth } from '../useElementWidth';
import styles from '../style.module.css';

const HEIGHT = 200;
const PAD_TOP = 10;
const PAD_BOTTOM = 26;
/** La place d'un chiffre des graduations, à 11 px : celle des plus longues décide de la marge. */
const DIGIT_WIDTH = 7;
const PAD_RIGHT = 10;
/** La largeur supposée avant la première mesure. */
const FALLBACK_WIDTH = 640;
/** La place d'une étiquette de date : en dessous, elles se chevauchent. */
const TICK_SPACING = 72;
const GRID_STEPS = 4;

/** Le haut de l'axe : un multiple rond (1, 2 ou 5 × 10ⁿ) de quatre pas, pour des graduations entières. */
function niceTop(max: number): number {
    const rough = Math.max(1, max) / GRID_STEPS;
    const power = 10 ** Math.floor(Math.log10(rough));
    const step = [1, 2, 5, 10].map((factor) => factor * power).find((candidate) => candidate >= rough) ?? rough;
    return Math.max(1, Math.ceil(step)) * GRID_STEPS;
}

interface TrendChartProps {
    points: readonly ShortlinkPoint[];
    bucket: ShortlinkStats['bucket'];
}

/**
 * Les visites et les ouvertures sur la période, sur un seul axe : elles se
 * comptent dans la même unité, et « 400 ouvertures pour 120 visites » est une
 * seule information. Les visites portent l'accent, les ouvertures restent en
 * retrait, en tirets pour ne pas tenir à la seule couleur.
 *
 * Le survol (ou les flèches au clavier) place un curseur : la légende dit alors
 * les valeurs de ce point plutôt que les totaux. Un tableau masqué donne les
 * mêmes chiffres aux lecteurs d'écran.
 */
export default function TrendChart({ points, bucket }: TrendChartProps) {
    const [frameRef, measured] = useElementWidth<HTMLDivElement>();
    const [cursor, setCursor] = useState<number | null>(null);
    const fillId = useId();
    const legendId = useId();

    const width = measured > 0 ? measured : FALLBACK_WIDTH;
    const count = points.length;
    const top = niceTop(Math.max(0, ...points.map((point) => Math.max(point.clicks, point.visits))));
    const padLeft = formatCount(top).length * DIGIT_WIDTH + 12;
    const plotW = Math.max(1, width - padLeft - PAD_RIGHT);
    const plotH = HEIGHT - PAD_TOP - PAD_BOTTOM;
    const baseline = PAD_TOP + plotH;
    const x = (index: number) => padLeft + (count <= 1 ? plotW / 2 : (index / (count - 1)) * plotW);
    const y = (value: number) => baseline - (value / top) * plotH;

    const line = (pick: (point: ShortlinkPoint) => number) =>
        points.map((point, i) => `${i === 0 ? 'M' : 'L'} ${x(i).toFixed(1)} ${y(pick(point)).toFixed(1)}`).join(' ');
    const area =
        count > 1
            ? `${line((p) => p.visits)} L ${x(count - 1).toFixed(1)} ${baseline} L ${x(0).toFixed(1)} ${baseline} Z`
            : '';

    // Les étiquettes partent de la dernière date, la plus regardée, et s'espacent
    // assez pour ne jamais se chevaucher.
    const every = Math.max(1, Math.ceil(count / Math.max(2, Math.floor(plotW / TICK_SPACING))));
    const ticks = points.flatMap((point, i) => ((count - 1 - i) % every === 0 ? [{ point, i }] : []));
    const grid = Array.from({ length: GRID_STEPS + 1 }, (_, step) => (top / GRID_STEPS) * step);

    const totalVisits = points.reduce((sum, point) => sum + point.visits, 0);
    const totalClicks = points.reduce((sum, point) => sum + point.clicks, 0);
    const focused = cursor === null ? null : (points[cursor] ?? null);

    const pick = (event: PointerEvent<SVGRectElement>) => {
        if (count === 0) return;
        const box = event.currentTarget.ownerSVGElement?.getBoundingClientRect();
        if (!box || box.width === 0) return;
        const px = ((event.clientX - box.left) / box.width) * width;
        const ratio = count <= 1 ? 0 : (px - padLeft) / plotW;
        setCursor(Math.min(count - 1, Math.max(0, Math.round(ratio * (count - 1)))));
    };

    const onKeyDown = (event: KeyboardEvent<SVGSVGElement>) => {
        if (count === 0) return;
        const from = cursor ?? count - 1;
        const next =
            event.key === 'ArrowLeft'
                ? from - 1
                : event.key === 'ArrowRight'
                  ? from + 1
                  : event.key === 'Home'
                    ? 0
                    : event.key === 'End'
                      ? count - 1
                      : null;
        if (event.key === 'Escape') {
            setCursor(null);
            return;
        }
        if (next === null) return;
        event.preventDefault();
        setCursor(Math.min(count - 1, Math.max(0, next)));
    };

    return (
        <figure className={styles.chart}>
            <div ref={frameRef} className={styles.chartFrame}>
                <svg
                    width={width}
                    height={HEIGHT}
                    viewBox={`0 0 ${width} ${HEIGHT}`}
                    className={styles.chartSvg}
                    role='img'
                    tabIndex={0}
                    aria-label={`Visites et ouvertures sur la période : ${formatCount(totalVisits)} visites, ${formatCount(totalClicks)} ouvertures. Flèches gauche et droite pour parcourir les dates.`}
                    aria-describedby={legendId}
                    onKeyDown={onKeyDown}
                    onFocus={() => setCursor((current) => current ?? (count > 0 ? count - 1 : null))}
                    onBlur={() => setCursor(null)}
                >
                    <defs>
                        <linearGradient id={fillId} x1='0' y1='0' x2='0' y2='1'>
                            <stop offset='0%' stopColor='var(--accent)' stopOpacity='0.16' />
                            <stop offset='100%' stopColor='var(--accent)' stopOpacity='0.02' />
                        </linearGradient>
                    </defs>

                    {grid.map((value) => (
                        <g key={value}>
                            <line
                                x1={padLeft}
                                x2={padLeft + plotW}
                                y1={y(value)}
                                y2={y(value)}
                                className={styles.chartGrid}
                            />
                            <text x={padLeft - 8} y={y(value) + 4} className={styles.chartTick} textAnchor='end'>
                                {formatCount(value)}
                            </text>
                        </g>
                    ))}

                    {area && <path d={area} fill={`url(#${fillId})`} />}
                    {count > 1 && <path d={line((p) => p.clicks)} className={styles.chartLineSecondary} />}
                    {count > 1 && <path d={line((p) => p.visits)} className={styles.chartLine} />}

                    {ticks.map(({ point, i }) => (
                        <text
                            key={point.at}
                            x={x(i)}
                            y={HEIGHT - 6}
                            className={styles.chartTick}
                            textAnchor={
                                i === 0 && count > 1 ? 'start' : i === count - 1 && count > 1 ? 'end' : 'middle'
                            }
                        >
                            {formatPointLabel(point.at)}
                        </text>
                    ))}

                    {focused !== null && cursor !== null && (
                        <g>
                            <line
                                x1={x(cursor)}
                                x2={x(cursor)}
                                y1={PAD_TOP}
                                y2={baseline}
                                className={styles.chartCursor}
                            />
                            <circle cx={x(cursor)} cy={y(focused.clicks)} r={4} className={styles.chartDotSecondary} />
                            <circle cx={x(cursor)} cy={y(focused.visits)} r={4} className={styles.chartDot} />
                        </g>
                    )}

                    {/* Toute la hauteur du tracé capte le pointeur : on vise une date, jamais un trait de deux pixels. */}
                    <rect
                        x={padLeft}
                        y={0}
                        width={plotW}
                        height={baseline}
                        fill='transparent'
                        onPointerMove={pick}
                        onPointerDown={pick}
                        onPointerLeave={() => setCursor(null)}
                    />
                </svg>
            </div>

            <figcaption id={legendId} className={styles.chartLegend} aria-live='polite'>
                <span className={styles.legendItem}>
                    <span className={styles.legendKey} aria-hidden='true' />
                    <strong>{formatCount(focused ? focused.visits : totalVisits)}</strong> visites
                </span>
                <span className={styles.legendItem}>
                    <span className={styles.legendKeySecondary} aria-hidden='true' />
                    <strong>{formatCount(focused ? focused.clicks : totalClicks)}</strong> ouvertures
                </span>
                <span className={styles.legendWhen}>
                    {focused ? formatPointTitle(focused.at, bucket) : 'Sur toute la période'}
                </span>
            </figcaption>

            <table className={styles.srOnly}>
                <caption>
                    {bucket === 'week' ? 'Visites et ouvertures par semaine' : 'Visites et ouvertures par jour'}
                </caption>
                <thead>
                    <tr>
                        <th scope='col'>{bucket === 'week' ? 'Semaine' : 'Jour'}</th>
                        <th scope='col'>Visites</th>
                        <th scope='col'>Ouvertures</th>
                    </tr>
                </thead>
                <tbody>
                    {points.map((point) => (
                        <tr key={point.at}>
                            <th scope='row'>{formatPointTitle(point.at, bucket)}</th>
                            <td>{formatCount(point.visits)}</td>
                            <td>{formatCount(point.clicks)}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </figure>
    );
}
