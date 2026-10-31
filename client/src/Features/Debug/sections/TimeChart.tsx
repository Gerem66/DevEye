import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from 'react';

import { formatClock } from '../format';
import styles from '../Debug.module.css';

export interface TimeSeries {
    label: string;
    /** Un jeton du thème : `var(--accent)`. */
    color: string;
    values: readonly (number | null)[];
    /** Sur l'axe de droite, dans son unité : les utilisateurs à côté des millisecondes. */
    right?: boolean;
}

export interface TimeMark {
    t: number;
    label: string;
    tone: 'warning' | 'danger';
}

const H = 170;
const PAD_LEFT = 52;
const PAD_RIGHT_AXIS = 44;
const PAD_TOP = 14;
const PAD_BOTTOM = 22;
const PLOT_H = H - PAD_TOP - PAD_BOTTOM;
/** La place d'une étiquette de temps (« 12:35 ») et de son écart, en pixels. */
const X_LABEL_SPACE = 64;

/** La largeur du conteneur, suivie : 0 tant qu'elle n'est pas mesurée. */
function useWidth(): [RefObject<HTMLDivElement | null>, number] {
    const ref = useRef<HTMLDivElement | null>(null);
    const [width, setWidth] = useState(0);
    useEffect(() => {
        const el = ref.current;
        if (!el) return;
        const observer = new ResizeObserver(([entry]) => setWidth(Math.round(entry.contentRect.width)));
        observer.observe(el);
        return () => observer.disconnect();
    }, []);
    return [ref, width];
}

/** Le plafond rond d'un axe : 1, 2, 2,5 ou 5 fois une puissance de dix. */
function niceCeil(value: number): number {
    if (value <= 0) return 1;
    const magnitude = 10 ** Math.floor(Math.log10(value));
    return [1, 2, 2.5, 5, 10].map((f) => f * magnitude).find((top) => top >= value) ?? 10 * magnitude;
}

const peak = (values: readonly (number | null)[]): number | null => {
    const known = values.filter((v): v is number => v !== null);
    return known.length > 0 ? Math.max(...known) : null;
};

/**
 * Une courbe de la montée en charge, seau par seau : des séries sur un axe, au
 * plus une série sur un second axe à droite, ou des aires empilées (la part de
 * chaque fonctionnalité). Des repères verticaux situent les seuils. Tracée à la
 * largeur mesurée, un pixel par unité, pour que le texte garde sa taille.
 */
export default function TimeChart({
    title,
    t,
    series,
    format,
    formatRight = format,
    stacked = false,
    marks = []
}: {
    title: string;
    /** La fin de chaque seau, en secondes depuis le début. */
    t: readonly number[];
    series: readonly TimeSeries[];
    format: (value: number) => string;
    formatRight?: (value: number) => string;
    stacked?: boolean;
    marks?: readonly TimeMark[];
}) {
    const [hover, setHover] = useState<number | null>(null);
    const [box, W] = useWidth();
    const left = series.filter((s) => !s.right);
    const right = stacked ? [] : series.filter((s) => s.right);
    const padRight = right.length > 0 ? PAD_RIGHT_AXIS : 8;
    const plotW = Math.max(1, W - PAD_LEFT - padRight);
    const n = t.length;

    // Empilées, chaque aire repose sur la somme des précédentes.
    const bases: number[][] = [];
    if (stacked) {
        let running = t.map(() => 0);
        for (const s of left) {
            bases.push(running);
            running = running.map((base, i) => base + (s.values[i] ?? 0));
        }
    }
    const leftTop = niceCeil(
        stacked
            ? Math.max(0, ...t.map((_, i) => left.reduce((sum, s) => sum + (s.values[i] ?? 0), 0)))
            : Math.max(0, ...left.map((s) => peak(s.values) ?? 0))
    );
    const rightTop = niceCeil(Math.max(0, ...right.map((s) => peak(s.values) ?? 0)));

    const x = (i: number): number => PAD_LEFT + (n <= 1 ? plotW / 2 : (i * plotW) / (n - 1));
    const y = (v: number, top: number): number => PAD_TOP + PLOT_H - (Math.min(v, top) / top) * PLOT_H;

    const linePath = (values: readonly (number | null)[], top: number): string => {
        let d = '';
        let pen = false;
        values.forEach((v, i) => {
            if (v === null) {
                pen = false;
                return;
            }
            d += `${pen ? 'L' : 'M'} ${x(i).toFixed(1)} ${y(v, top).toFixed(1)} `;
            pen = true;
        });
        return d.trim();
    };
    const areaPath = (values: readonly (number | null)[], base: readonly number[]): string => {
        const upper = values.map((v, i) => `${x(i).toFixed(1)} ${y(base[i] + (v ?? 0), leftTop).toFixed(1)}`);
        const lower = base.map((b, i) => `${x(i).toFixed(1)} ${y(b, leftTop).toFixed(1)}`).reverse();
        return `M ${upper.join(' L ')} L ${lower.join(' L ')} Z`;
    };

    const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(plotW / X_LABEL_SPACE))));
    const xLabels = t.map((s, i) => ({ i, s })).filter(({ i }) => i % every === 0 || i === n - 1);
    // La dernière s'aligne à droite du tracé : sa voisine trop proche s'efface.
    if (xLabels.length > 1 && x(xLabels[xLabels.length - 1].i) - x(xLabels[xLabels.length - 2].i) < X_LABEL_SPACE) {
        xLabels.splice(xLabels.length - 2, 1);
    }

    const pick = (clientX: number, rect: DOMRect): void => {
        if (n === 0) return;
        const svgX = ((clientX - rect.left) / rect.width) * W;
        const i = n <= 1 ? 0 : Math.round(((svgX - PAD_LEFT) / plotW) * (n - 1));
        setHover(Math.min(n - 1, Math.max(0, i)));
    };
    const onKey = (e: KeyboardEvent<SVGSVGElement>): void => {
        if (n === 0 || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
        e.preventDefault();
        const from = hover ?? n - 1;
        setHover(Math.min(n - 1, Math.max(0, from + (e.key === 'ArrowRight' ? 1 : -1))));
    };

    return (
        <figure className={styles.chart}>
            <figcaption className={styles.chartTitle}>{title}</figcaption>
            <div ref={box} className={styles.chartBox}>
                {W > 0 && n > 0 && (
                    <svg
                        viewBox={`0 0 ${W} ${H}`}
                        className={styles.chartSvg}
                        role='img'
                        tabIndex={0}
                        aria-label={`${title}. ${series
                            .map((s) => {
                                const p = peak(s.values);
                                const fmt = s.right ? formatRight : format;
                                return `${s.label} : ${p === null ? 'aucune valeur' : `au plus ${fmt(p)}`}`;
                            })
                            .join('. ')}. Flèches gauche et droite pour lire seau par seau.`}
                        onKeyDown={onKey}
                        onBlur={() => setHover(null)}
                    >
                        {[0, leftTop / 2, leftTop].map((v) => (
                            <g key={v}>
                                <line
                                    x1={PAD_LEFT}
                                    x2={PAD_LEFT + plotW}
                                    y1={y(v, leftTop)}
                                    y2={y(v, leftTop)}
                                    className={styles.chartGrid}
                                />
                                <text
                                    x={PAD_LEFT - 8}
                                    y={y(v, leftTop) + 4}
                                    className={styles.chartTick}
                                    textAnchor='end'
                                >
                                    {format(v)}
                                </text>
                            </g>
                        ))}
                        {right.length > 0 &&
                            [0, rightTop / 2, rightTop].map((v) => (
                                <text
                                    key={v}
                                    x={PAD_LEFT + plotW + 8}
                                    y={y(v, rightTop) + 4}
                                    className={styles.chartTick}
                                    textAnchor='start'
                                >
                                    {formatRight(v)}
                                </text>
                            ))}
                        {xLabels.map(({ i, s }) => (
                            <text
                                key={i}
                                x={x(i)}
                                y={H - 6}
                                className={styles.chartTick}
                                textAnchor={i === 0 && n > 1 ? 'start' : i === n - 1 && n > 1 ? 'end' : 'middle'}
                            >
                                {formatClock(s)}
                            </text>
                        ))}

                        {stacked
                            ? left.map((s, k) => (
                                  <path
                                      key={s.label}
                                      d={areaPath(s.values, bases[k])}
                                      className={styles.chartArea}
                                      style={{ fill: s.color }}
                                  />
                              ))
                            : series.map((s) => (
                                  <path
                                      key={s.label}
                                      d={linePath(s.values, s.right ? rightTop : leftTop)}
                                      className={s.right ? styles.chartLineThin : styles.chartLine}
                                      style={{ stroke: s.color }}
                                  />
                              ))}

                        {marks.map((m) => {
                            const i = t.indexOf(m.t);
                            if (i < 0) return null;
                            return (
                                <g
                                    key={m.label}
                                    className={m.tone === 'danger' ? styles.markDanger : styles.markWarning}
                                >
                                    <line
                                        x1={x(i)}
                                        x2={x(i)}
                                        y1={PAD_TOP}
                                        y2={PAD_TOP + PLOT_H}
                                        className={styles.markLine}
                                    />
                                    <text x={x(i)} y={PAD_TOP - 4} className={styles.markText} textAnchor='middle'>
                                        {m.label}
                                    </text>
                                </g>
                            );
                        })}

                        {hover !== null && (
                            <line
                                x1={x(hover)}
                                x2={x(hover)}
                                y1={PAD_TOP}
                                y2={PAD_TOP + PLOT_H}
                                className={styles.chartCursor}
                            />
                        )}

                        {/* La zone de survol couvre tout le tracé : on vise un instant, pas une ligne de deux pixels. */}
                        <rect
                            x={PAD_LEFT}
                            y={PAD_TOP}
                            width={plotW}
                            height={PLOT_H}
                            fill='transparent'
                            onPointerMove={(e: PointerEvent<SVGRectElement>) =>
                                pick(e.clientX, e.currentTarget.ownerSVGElement!.getBoundingClientRect())
                            }
                            onPointerLeave={() => setHover(null)}
                        />
                    </svg>
                )}
            </div>

            {/* La légende porte la lecture du seau survolé, sinon le pic de chaque série. */}
            <div className={styles.chartLegend}>
                {series.map((s) => {
                    const v = hover === null ? peak(s.values) : s.values[hover];
                    const fmt = s.right && !stacked ? formatRight : format;
                    return (
                        <span key={s.label} className={styles.legendItem}>
                            <span className={styles.legendSwatch} style={{ background: s.color }} aria-hidden='true' />
                            {v !== null && v !== undefined && <strong className={styles.legendValue}>{fmt(v)}</strong>}
                            {s.label}
                        </span>
                    );
                })}
                <span className={styles.legendWhen}>
                    {hover === null ? 'au plus haut, survolez pour lire un instant' : `à ${formatClock(t[hover])}`}
                </span>
            </div>
        </figure>
    );
}
