import { MiniGraph, type Series } from './MiniGraph';
import { formatDuration } from './utils';
import styles from './Monitoring.module.css';

export interface DetailRow {
    label: string;
    value: string;
}

const fmtClock = (t: number) => new Date(t).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

/** Body of the per-graph detail popup: a larger chart + a full stats table. */
export function GraphDetail({
    series,
    yMax,
    rows,
    period,
    format
}: {
    series: Series[];
    yMax?: number;
    rows: DetailRow[];
    /** Time window the chart covers, shown explicitly above the stats. */
    period?: { start: number; end: number };
    /** Value formatter for the hover tooltip. */
    format?: (v: number) => string;
}) {
    const periodRows: DetailRow[] = period
        ? [
              { label: 'Période', value: `${fmtClock(period.start)} – ${fmtClock(period.end)}` },
              { label: 'Durée', value: formatDuration(period.end - period.start) }
          ]
        : [];
    return (
        <div className={styles.graphDetail}>
            <MiniGraph title='' series={series} yMax={yMax} stat={<span />} tall format={format} />
            <dl className={styles.graphDetailStats}>
                {[...periodRows, ...rows].map((r) => (
                    <div key={r.label} className={styles.graphDetailRow}>
                        <dt>{r.label}</dt>
                        <dd>{r.value}</dd>
                    </div>
                ))}
            </dl>
        </div>
    );
}
