import { forwardRef, type ReactNode } from 'react';
import { motion, type HTMLMotionProps } from 'framer-motion';
import styles from './Widget.module.css';

export interface WidgetProps extends Omit<HTMLMotionProps<'div'>, 'children'> {
    /** Unique ID used as framer-motion layoutId for shared-element transitions. */
    widgetId: string;
    /** Widget heading/title shown in the header. */
    title?: string;
    /** Optional icon (class name) displayed before the title. */
    icon?: string;
    /** Content rendered inside the widget body. */
    children?: ReactNode;
    /** Called when the widget is clicked (e.g., to expand into popup). */
    onExpand?: () => void;
    /** Additional className for the outer wrapper. */
    className?: string;
}

/**
 * Glassmorphism widget card. Uses framer-motion `layoutId` for smooth expansion
 * into a popup. Clicking anywhere triggers `onExpand`.
 */
const Widget = forwardRef<HTMLDivElement, WidgetProps>(function Widget(
    { widgetId, title, icon, children, onExpand, className, ...motionProps },
    ref
) {
    return (
        <motion.div
            ref={ref}
            layoutId={widgetId}
            className={`${styles.widget} ${className ?? ''}`}
            onClick={onExpand}
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
            transition={{ type: 'spring', stiffness: 400, damping: 30 }}
            {...motionProps}
        >
            {title && (
                <div className={styles.header}>
                    {icon && <span className={`icon-${icon} ${styles.icon}`} />}
                    <span className={styles.title}>{title}</span>
                </div>
            )}
            <div className={styles.body}>{children}</div>
        </motion.div>
    );
});

export default Widget;
