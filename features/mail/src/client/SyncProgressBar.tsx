import styles from './style.module.css';

interface SyncProgressBarProps {
    /** 0-1, or `null` for "syncing but no folder count yet" (indeterminate). */
    progress: number | null;
}

/**
 * Thin strip pinned to the top of its (positioned, `overflow: hidden`) container,
 * used on both the account card and the selected-account header, so the same
 * sync is visible from either slide of Panel A.
 */
export function SyncProgressBar({ progress }: SyncProgressBarProps) {
    return (
        <div className={styles.syncProgressTrack} aria-hidden='true'>
            <div
                className={`${styles.syncProgressFill} ${progress === null ? styles.syncProgressIndeterminate : ''}`}
                style={progress !== null ? { width: `${Math.round(progress * 100)}%` } : undefined}
            />
        </div>
    );
}

export default SyncProgressBar;
