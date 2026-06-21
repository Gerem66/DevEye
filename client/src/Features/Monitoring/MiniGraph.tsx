import { type ReactNode, useId } from 'react';
import styles from './Monitoring.module.css';

export interface Series {
    points: { t: number; v: number }[];
    color: string;
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
    /** Taller chart body, for the detail popup. */
    tall?: boolean;
}

const W = 240;
const H = 60;

/**
 * Small time-aware line chart. The x-axis spans the real timestamp range across
 * all series, so irregular sample gaps are drawn to scale. Filled area under the
 * first series for a denser look.
 */
export function MiniGraph({ title, series, yMax, stat, onClick, tall }: MiniGraphProps) {
    const id = useId();
    const all = series.flatMap((s) => s.points);
    const hasData = all.length >= 2;

    let body: ReactNode;
    if (!hasData) {
        body = <div className={styles.graphEmpty}>—</div>;
    } else {
        const tMin = Math.min(...all.map((p) => p.t));
        const tMax = Math.max(...all.map((p) => p.t));
        const tSpan = Math.max(1, tMax - tMin);
        const dataMax = Math.max(...all.map((p) => p.v));
        const yTop = yMax ?? Math.max(1, dataMax * 1.15);

        const toXY = (p: { t: number; v: number }) => {
            const x = ((p.t - tMin) / tSpan) * W;
            const y = H - Math.max(0, Math.min(1, p.v / yTop)) * H;
            return [x, y] as const;
        };

        body = (
            <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio='none' className={styles.graphSvg}>
                {series.map((s, si) => {
                    if (s.points.length < 2) return null;
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
            <div className={bodyClass}>{body}</div>
        </div>
    );
}
