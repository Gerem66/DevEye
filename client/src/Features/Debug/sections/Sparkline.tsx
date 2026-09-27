import styles from '../Debug.module.css';

const W = 80;
const H = 20;

/** L'allure d'une série, du plus ancien au plus récent : une ligne, sans axe. */
export default function Sparkline({ values, label }: { values: readonly number[]; label: string }) {
    if (values.length < 2) return null;
    const min = Math.min(...values);
    const span = Math.max(...values) - min || 1;
    const points = values
        .map(
            (v, i) =>
                `${((i / (values.length - 1)) * W).toFixed(1)},${(H - 2 - ((v - min) / span) * (H - 4)).toFixed(1)}`
        )
        .join(' ');
    return (
        <svg className={styles.sparkline} viewBox={`0 0 ${W} ${H}`} role='img' aria-label={label}>
            <polyline points={points} fill='none' stroke='currentColor' strokeWidth='1.5' strokeLinejoin='round' />
        </svg>
    );
}
