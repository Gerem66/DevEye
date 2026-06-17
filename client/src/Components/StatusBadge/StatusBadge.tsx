import type { ReactNode } from 'react';
import styles from './StatusBadge.module.css';

export type BadgeTone = 'online' | 'offline' | 'success' | 'warning' | 'danger' | 'accent' | 'neutral';

export interface StatusBadgeProps {
    tone?: BadgeTone;
    /** Show the leading status dot (default true). */
    dot?: boolean;
    children: ReactNode;
    className?: string;
}

/** Small pill used for device presence / feature status across the app. */
export default function StatusBadge({ tone = 'neutral', dot = true, children, className }: StatusBadgeProps) {
    return (
        <span className={`${styles.badge} ${styles[tone]} ${className ?? ''}`}>
            {dot && <span className={styles.dot} />}
            {children}
        </span>
    );
}
