import type { DailyPoint } from '../contracts/domain';
import styles from './style.module.css';

/** Reçus et envoyés par jour, en barres côte à côte. Les refus et non-remises se lisent dans le tableau dessous. */
export default function ActivityChart({ daily }: { daily: readonly DailyPoint[] }) {
    const peak = Math.max(1, ...daily.map((point) => Math.max(point.received, point.sent)));
    const width = 100 / Math.max(1, daily.length);
    const label = (day: string): string =>
        new Date(`${day}T00:00:00Z`).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', timeZone: 'UTC' });

    return (
        <figure className={styles.chart}>
            <svg
                viewBox='0 0 100 40'
                preserveAspectRatio='none'
                className={styles.chartPlot}
                role='img'
                aria-label='Messages reçus et envoyés par jour'
            >
                {daily.map((point, index) => {
                    const x = index * width;
                    const bar = width * 0.36;
                    const received = (point.received / peak) * 38;
                    const sent = (point.sent / peak) * 38;
                    return (
                        <g key={point.day}>
                            <title>{`${label(point.day)} : ${point.received} reçu(s), ${point.sent} envoyé(s)`}</title>
                            <rect
                                className={styles.barReceived}
                                x={x + width * 0.1}
                                y={40 - received}
                                width={bar}
                                height={received}
                            />
                            <rect
                                className={styles.barSent}
                                x={x + width * 0.1 + bar + width * 0.08}
                                y={40 - sent}
                                width={bar}
                                height={sent}
                            />
                        </g>
                    );
                })}
            </svg>
            <figcaption className={styles.chartLegend}>
                <span>{daily.length > 0 ? label(daily[0].day) : ''}</span>
                <span className={styles.legendItems}>
                    <span className={styles.legendReceived}>Reçus</span>
                    <span className={styles.legendSent}>Envoyés</span>
                </span>
                <span>{daily.length > 0 ? label(daily[daily.length - 1].day) : ''}</span>
            </figcaption>
        </figure>
    );
}
