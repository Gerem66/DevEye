import styles from './Clients.module.css';

/** DA-styled on/off switch (replaces the native checkbox). */
export function Switch({
    checked,
    onChange,
    label,
    hint
}: {
    checked: boolean;
    onChange: (v: boolean) => void;
    label: string;
    hint?: string;
}) {
    return (
        <button
            type='button'
            role='switch'
            aria-checked={checked}
            className={`${styles.switch} ${checked ? styles.switchOn : ''}`}
            onClick={() => onChange(!checked)}
        >
            <span className={styles.switchTrack}>
                <span className={styles.switchThumb} />
            </span>
            <span className={styles.switchText}>
                {label}
                {hint && <span className={styles.switchHint}>{hint}</span>}
            </span>
        </button>
    );
}
