import styles from './style.module.css';

interface ProgressBarProps {
    /** De 0 à 1. `null` : on travaille, sans savoir dire où l'on en est. */
    ratio: number | null;
    label: string;
}

export function ProgressBar({ ratio, label }: ProgressBarProps) {
    const percent = ratio === null ? undefined : Math.round(Math.min(1, Math.max(0, ratio)) * 100);
    return (
        <div
            className={styles.bar}
            role='progressbar'
            aria-label={label}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
        >
            <div
                className={`${styles.barFill} ${percent === undefined ? styles.barIndeterminate : ''}`}
                style={percent === undefined ? undefined : { width: `${percent}%` }}
            />
        </div>
    );
}
