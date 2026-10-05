import styles from './ProgressDialog.module.css';

export interface ProgressBarProps {
    /** L'avancement, de 0 à 1, quand il se mesure. Absent : la barre balaie sans rien promettre. */
    value?: number;
    /** Lu par les lecteurs d'écran. */
    label: string;
    className?: string;
}

export function ProgressBar({ value, label, className }: ProgressBarProps) {
    const percent = value === undefined ? undefined : Math.round(Math.min(1, Math.max(0, value)) * 100);
    return (
        <div
            className={`${styles.track} ${className ?? ''}`}
            role='progressbar'
            aria-label={label}
            aria-busy='true'
            aria-valuemin={percent === undefined ? undefined : 0}
            aria-valuemax={percent === undefined ? undefined : 100}
            aria-valuenow={percent}
        >
            {percent === undefined ? (
                <div className={styles.fill} />
            ) : (
                <div className={styles.measured} style={{ width: `${percent}%` }} />
            )}
        </div>
    );
}

export default ProgressBar;
