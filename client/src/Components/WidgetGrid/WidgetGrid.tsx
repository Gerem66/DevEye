import type { ReactNode } from 'react';
import styles from './WidgetGrid.module.css';

export interface WidgetGridProps {
    children: ReactNode;
    className?: string;
}

/**
 * Responsive CSS Grid container for Widget cards.
 * Auto-fills columns with a minimum width, wrapping as needed.
 */
export default function WidgetGrid({ children, className }: WidgetGridProps) {
    return <div className={`${styles.grid} ${className ?? ''}`}>{children}</div>;
}
