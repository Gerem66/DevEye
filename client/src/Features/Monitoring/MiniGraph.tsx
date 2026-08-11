import { type ReactNode, useId, useRef, useState } from 'react';
import { maxOf, minOf, nearestBy, niceTimeTicks } from './utils';
import styles from './Monitoring.module.css';

export interface Series {
    points: { t: number; v: number }[];
    color: string;
    /** Legend name shown in the hover tooltip (detail view). */
    label?: string;
}

interface MiniGraphProps {
    title: string;
    series: Series[];
    /** Fixed y-axis max (e.g. 100 for %). Omit to auto-scale to the data. */
    yMax?: number;
    /** Stat line shown under the title (current/avg/max, computed by caller). */
    stat: ReactNode;
    /** When set, the card is clickable (e.g. to open a detail popup). */
    onClick?: () => void;
    /** Taller chart body + interactive grid/hover, for the detail popup. */
    tall?: boolean;
    /** Value formatter for the hover tooltip (detail view). Defaults to raw number. */
    format?: (v: number) => string;
}

const W = 240;
const H = 60;

const fmtTick = (t: number) => new Date(t).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
const fmtExact = (t: number) =>
    new Date(t).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

/**
 * Small time-aware line chart. The x-axis spans the real timestamp range across
 * all series, so irregular sample gaps are drawn to scale. Filled area under the
 * first series for a denser look. In `tall` mode it also draws discreet hourly
 * grid lines and, on hover, highlights the nearest point with a value/time panel.
 */
export function MiniGraph({ title, series, yMax, stat, onClick, tall, format }: MiniGraphProps) {
    const id = useId();
    const bodyRef = useRef<HTMLDivElement>(null);
    const [hoverT, setHoverT] = useState<number | null>(null);

    const all = series.flatMap((s) => s.points);
    /**
     * Un seul relevé reste un relevé.
     *
     * Le seuil était à deux points, faute de quoi il n'y a pas de ligne à
     * tracer — mais une sélection étroite, ou large sur une cadence lente, n'en
     * contient parfois qu'un : toutes les cartes affichaient alors « — » sur
     * fond gris, indiscernables d'une absence de données, alors que la valeur
     * était bien là et que la frise montrait sa marque. On dessine le point.
     */
    const hasData = all.length >= 1;
    // Réductions et non `Math.min(...tableau)` : l'étalement passe chaque point
    // en argument, et au-delà de ~100 000 arguments l'appel lève un
    // `RangeError` — atteignable sur un panneau laissé ouvert en direct.
    const tMin = hasData ? minOf(all, (p) => p.t) : 0;
    const tMax = hasData ? maxOf(all, (p) => p.t) : 0;
    const tSpan = Math.max(1, tMax - tMin);

    const onMove = (e: React.PointerEvent) => {
        const el = bodyRef.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        setHoverT(tMin + frac * tSpan);
    };

    let body: ReactNode;
    if (!hasData) {
        body = <div className={styles.graphEmpty}>—</div>;
    } else {
        const dataMax = maxOf(all, (p) => p.v);
        const yTop = yMax ?? Math.max(1, dataMax * 1.15);

        // Tous les points au même instant (un seul relevé) : la fraction serait
        // 0/1 et les collerait au bord gauche. On les centre.
        const flat = tMax === tMin;
        const xPct = (t: number) => (flat ? 50 : ((t - tMin) / tSpan) * 100);
        const yPct = (v: number) => (1 - Math.max(0, Math.min(1, v / yTop))) * 100;
        const toXY = (p: { t: number; v: number }) => {
            const y = H - Math.max(0, Math.min(1, p.v / yTop)) * H;
            return [(xPct(p.t) / 100) * W, y] as const;
        };

        const gridTicks = tall ? niceTimeTicks(tMin, tMax) : [];
        const fmt = format ?? ((v: number) => String(Math.round(v)));

        // Hover: nearest point per series + the reference time (first series).
        const hoverHits =
            tall && hoverT !== null
                ? series.flatMap((s) => {
                      const p = nearestBy(s.points, hoverT, (p) => p.t);
                      return p ? [{ color: s.color, label: s.label, p }] : [];
                  })
                : [];
        const refT = hoverHits[0]?.p.t ?? null;

        body = (
            <>
                <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio='none' className={styles.graphSvg}>
                    {gridTicks.map((t) => {
                        const x = (xPct(t) / 100) * W;
                        return (
                            <line
                                key={`g${t}`}
                                x1={x}
                                x2={x}
                                y1={0}
                                y2={H}
                                className={styles.graphGridLine}
                                vectorEffect='non-scaling-stroke'
                            />
                        );
                    })}
                    {series.map((s, si) => {
                        if (s.points.length === 0) return null;
                        // Un point isolé : un marqueur, pas une ligne. Le viewBox
                        // est étiré (`preserveAspectRatio='none'`), donc un rect
                        // large-de-rien plutôt qu'un cercle, qui s'ovaliserait.
                        if (s.points.length === 1) {
                            const [x, y] = toXY(s.points[0]);
                            return (
                                <line
                                    key={si}
                                    x1={x}
                                    x2={x}
                                    y1={y}
                                    y2={H}
                                    stroke={s.color}
                                    strokeWidth='2'
                                    strokeLinecap='round'
                                    vectorEffect='non-scaling-stroke'
                                />
                            );
                        }
                        const pts = s.points.map(toXY);
                        const line = pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
                        const area = `0,${H} ${line} ${pts[pts.length - 1][0].toFixed(1)},${H}`;
                        return (
                            <g key={si}>
                                {si === 0 && (
                                    <>
                                        <linearGradient id={`${id}-${si}`} x1='0' y1='0' x2='0' y2='1'>
                                            <stop offset='0%' stopColor={s.color} stopOpacity='0.25' />
                                            <stop offset='100%' stopColor={s.color} stopOpacity='0' />
                                        </linearGradient>
                                        <polygon points={area} fill={`url(#${id}-${si})`} />
                                    </>
                                )}
                                <polyline
                                    points={line}
                                    fill='none'
                                    stroke={s.color}
                                    strokeWidth='1.5'
                                    strokeLinejoin='round'
                                    strokeLinecap='round'
                                />
                            </g>
                        );
                    })}
                </svg>

                {tall && (
                    <div className={styles.graphOverlay} aria-hidden>
                        {gridTicks.map((t) => (
                            <span key={`l${t}`} className={styles.graphGridLabel} style={{ left: `${xPct(t)}%` }}>
                                {fmtTick(t)}
                            </span>
                        ))}
                        {refT !== null && <div className={styles.graphCursor} style={{ left: `${xPct(refT)}%` }} />}
                        {hoverHits.map((h, i) => (
                            <span
                                key={`d${i}`}
                                className={styles.graphHoverDot}
                                style={{ left: `${xPct(h.p.t)}%`, top: `${yPct(h.p.v)}%`, background: h.color }}
                            />
                        ))}
                        {refT !== null && (
                            <div
                                className={styles.graphTooltip}
                                style={{ left: `${xPct(refT)}%` }}
                                data-side={xPct(refT) > 60 ? 'left' : 'right'}
                            >
                                <span className={styles.graphTooltipTime}>{fmtExact(refT)}</span>
                                {hoverHits.map((h, i) => (
                                    <span key={`v${i}`} className={styles.graphTooltipRow}>
                                        <span className={styles.graphTooltipDot} style={{ background: h.color }} />
                                        {h.label ? `${h.label} : ` : ''}
                                        {fmt(h.p.v)}
                                    </span>
                                ))}
                            </div>
                        )}
                    </div>
                )}
            </>
        );
    }

    const cardClass = `${styles.graphCard} ${onClick ? styles.graphCardClickable : ''}`;
    const bodyClass = `${styles.graphBody} ${tall ? styles.graphBodyTall : ''}`;

    return (
        <div
            className={cardClass}
            onClick={onClick}
            role={onClick ? 'button' : undefined}
            tabIndex={onClick ? 0 : undefined}
            onKeyDown={onClick ? (e) => (e.key === 'Enter' || e.key === ' ') && onClick() : undefined}
        >
            <div className={styles.graphHead}>
                <span className={styles.graphTitle}>{title}</span>
                {stat}
            </div>
            <div
                ref={bodyRef}
                className={bodyClass}
                onPointerMove={tall && hasData ? onMove : undefined}
                onPointerLeave={tall ? () => setHoverT(null) : undefined}
            >
                {body}
            </div>
        </div>
    );
}
