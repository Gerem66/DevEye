import styles from './style.module.css';

import type { ReactNode } from 'react';

interface PaneProps {
    /** A refresh is in flight for this block. */
    busy: boolean;
    children: ReactNode;
}

/**
 * A block that reloads **in place**.
 *
 * The uptime panels re-query on every probe, and swapping their content for a
 * "Chargement…" placeholder made the whole view jump: charts collapsed, the page
 * resized, then everything snapped back. Instead the last known content stays
 * mounted at its exact size, dimmed, with a spinner centred over it — so a
 * refresh reads as a subtle pulse rather than a glitch, and each block does it
 * on its own schedule.
 */
export function Pane({ busy, children }: PaneProps) {
    return (
        <div className={styles.pane}>
            <div className={`${styles.paneBody} ${busy ? styles.paneDim : ''}`}>{children}</div>
            {busy && (
                <span className={`icon icon-spinner ${styles.paneSpinner}`} role='status' aria-label='Actualisation' />
            )}
        </div>
    );
}

export default Pane;
