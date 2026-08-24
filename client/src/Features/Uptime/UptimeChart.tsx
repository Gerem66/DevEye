import { useRef, useState } from 'react';

import { formatBucket, formatMs, formatRatio } from './format';
import styles from './style.module.css';

import type { UptimePoint, UptimeResolution } from '@deveye/types';

const W = 600;
const H = 140;

interface UptimeChartProps {
    points: UptimePoint[];
    /** Window shared with the status strip, so both read on the same x-axis. */
    from: number;
    to: number;
    resolution: UptimeResolution;
}

/**
 * Response-time curve over the queried window, with the failing buckets shaded
 * in red behind it — one glance answers both "was it up?" and "was it slow?".
 *
 * The x-axis is the **selected window**, not the extent of the data, so it lines
 * up column for column with the status strip above: a service monitored for ten
 * minutes draws its curve in the last sliver of a 24 h view instead of being
 * stretched across it. Gaps in the history therefore read as gaps.
 *
 * The viewBox is fixed and the SVG scales to its container, which keeps the
 * whole thing resolution-independent with no resize observer.
 */
export function UptimeChart({ points, from, to, resolution }: UptimeChartProps) {
    const bodyRef = useRef<HTMLDivElement>(null);
    const [hover, setHover] = useState<UptimePoint | null>(null);

    if (points.length === 0) {
        return <div className={styles.chartEmpty}>Aucune donnée sur cette période.</div>;
    }

    const tMin = from;
    const tMax = to;
    const tSpan = Math.max(1, tMax - tMin);
    const msMax = Math.max(1, ...points.map((p) => p.avgMs ?? 0));

    const x = (at: number) => ((at - tMin) / tSpan) * W;
    const y = (ms: number) => H - (ms / (msMax * 1.15)) * H;

    // Only the points that actually carry a latency take part in the curve; a
    // total outage has none, and joining across it would draw a phantom line.
    const timed = points.filter((p) => p.avgMs !== null);
    const line = timed.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.at).toFixed(1)},${y(p.avgMs ?? 0).toFixed(1)}`);
    // One bucket's width, used to give the failure bands a visible thickness.
    // Capped: on a sparse series a raw `W / points.length` would paint a whole
    // region red for one failed bucket, wildly overstating the outage.
    const bandWidth = Math.min(Math.max(1.5, W / points.length), 12);

    function onMove(e: React.PointerEvent) {
        const el = bodyRef.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        const at = tMin + ((e.clientX - rect.left) / rect.width) * tSpan;
        let best = points[0];
        for (const p of points) {
            if (Math.abs(p.at - at) < Math.abs(best.at - at)) best = p;
        }
        setHover(best);
    }

    return (
        <div className={styles.chart}>
            <div
                ref={bodyRef}
                className={styles.chartBody}
                onPointerMove={onMove}
                onPointerLeave={() => setHover(null)}
            >
                <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio='none' className={styles.chartSvg}>
                    {points
                        .filter((p) => p.upChecks < p.checks)
                        .map((p) => (
                            <rect
                                key={p.at}
                                x={Math.max(0, x(p.at) - bandWidth / 2)}
                                y={0}
                                width={bandWidth}
                                height={H}
                                className={styles.chartFail}
                                // Partial failures shade proportionally, so a bucket
                                // that dropped 1 ping in 60 doesn't read like an outage.
                                opacity={0.18 + 0.62 * (1 - p.upChecks / p.checks)}
                            />
                        ))}
                    {line.length > 1 && <path d={line.join(' ')} className={styles.chartLine} />}
                    {hover && <line x1={x(hover.at)} x2={x(hover.at)} y1={0} y2={H} className={styles.chartCursor} />}
                </svg>
            </div>

            <div className={styles.chartFoot}>
                <span>{formatBucket(tMin, resolution === 'day')}</span>
                {hover ? (
                    <span className={styles.chartHover}>
                        {formatBucket(hover.at, resolution === 'day')} · {formatMs(hover.avgMs)} ·{' '}
                        {formatRatio(hover.upChecks / hover.checks)}
                    </span>
                ) : (
                    <span className={styles.chartScale}>max {formatMs(msMax)}</span>
                )}
                <span>{formatBucket(tMax, resolution === 'day')}</span>
            </div>
        </div>
    );
}

export default UptimeChart;
