import styles from '../style.module.css';

const WIDTH = 88;
const HEIGHT = 26;
const PAD = 3;

/**
 * La petite courbe d'une ligne de la liste : les visites des derniers jours, en
 * retrait, et le dernier jour en accent. Décorative : le total est écrit à côté.
 */
export default function Sparkline({ values }: { values: readonly number[] }) {
    if (values.length === 0) return null;
    const max = Math.max(1, ...values);
    const step = values.length > 1 ? (WIDTH - PAD * 2) / (values.length - 1) : 0;
    const x = (index: number) => PAD + index * step;
    const y = (value: number) => HEIGHT - PAD - (value / max) * (HEIGHT - PAD * 2);
    const path = values.map((value, i) => `${i === 0 ? 'M' : 'L'} ${x(i).toFixed(1)} ${y(value).toFixed(1)}`).join(' ');
    const last = values.length - 1;

    return (
        <svg
            className={styles.sparkline}
            width={WIDTH}
            height={HEIGHT}
            viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
            aria-hidden='true'
            focusable='false'
        >
            <path d={path} className={styles.sparkLine} />
            <circle cx={x(last)} cy={y(values[last])} r={2.5} className={styles.sparkDot} />
        </svg>
    );
}
