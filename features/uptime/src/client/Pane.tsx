import styles from './style.module.css';

import type { ReactNode } from 'react';

interface PaneProps {
    /** A refresh is in flight for this block. */
    busy: boolean;
    children: ReactNode;
}

/**
 * A block that reloads in place: the last content stays mounted at its exact
 * size, dimmed, with a spinner over it, so a refresh never shifts the layout.
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
