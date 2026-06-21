import { MiniGraph, type Series } from './MiniGraph';
import styles from './Monitoring.module.css';

export interface DetailRow {
    label: string;
    value: string;
}

/** Body of the per-graph detail popup: a larger chart + a full stats table. */
export function GraphDetail({ series, yMax, rows }: { series: Series[]; yMax?: number; rows: DetailRow[] }) {
    return (
        <div className={styles.graphDetail}>
            <MiniGraph title='' series={series} yMax={yMax} stat={<span />} tall />
            <dl className={styles.graphDetailStats}>
                {rows.map((r) => (
                    <div key={r.label} className={styles.graphDetailRow}>
                        <dt>{r.label}</dt>
                        <dd>{r.value}</dd>
                    </div>
                ))}
            </dl>
        </div>
    );
}
