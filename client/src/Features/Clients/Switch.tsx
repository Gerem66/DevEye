import styles from './Clients.module.css';

/** DA-styled on/off switch (replaces the native checkbox). */
export function Switch({
    checked,
    onChange,
    label,
    hint,
    disabled
}: {
    checked: boolean;
    onChange: (v: boolean) => void;
    label: string;
    hint?: string;
    /** Choix imposé (ex. l'espace d'appairage d'un appareil) : affiché, non modifiable. */
    disabled?: boolean;
}) {
    return (
        <button
            type='button'
            role='switch'
            aria-checked={checked}
            disabled={disabled}
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
