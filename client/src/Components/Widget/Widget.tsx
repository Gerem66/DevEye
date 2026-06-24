import { forwardRef, type ElementType, type ReactNode, type MouseEvent } from 'react';
import { motion, type HTMLMotionProps } from 'framer-motion';
import styles from './Widget.module.css';

export interface WidgetProps extends Omit<HTMLMotionProps<'div'>, 'children'> {
    /** Unique ID used as framer-motion layoutId for shared-element transitions. */
    widgetId: string;
    /** Widget heading/title shown in the header. */
    title?: string;
    /** Optional icon (name) displayed before the title. */
    icon?: string;
    /** Content rendered inside the widget body. */
    children?: ReactNode;
    /** Called when the widget is clicked (e.g., to expand into popup). */
    onExpand?: (e: React.MouseEvent<HTMLDivElement>) => void;
    /** Additional className for the outer wrapper. */
    className?: string;
    /** Shorter card (e.g. device tiles), sized to their lighter content. */
    compact?: boolean;
    /** Even shorter "thin & long" card (shortcut tiles). */
    slim?: boolean;
    /**
     * Interactive (default): morphs via `layoutId`, lifts on hover, opens on
     * click. Set false for edit-mode cards — drops the morph/hover/click and the
     * expand hint so the card is a plain, drag-friendly surface.
     */
    interactive?: boolean;
    /**
     * When set, the card renders as an anchor opening this URL in a new tab — so
     * the browser shows the link on hover (status bar) and supports middle-click.
     * Used by shortcut tiles instead of a JS click handler.
     */
    href?: string;
}

/**
 * Glassmorphism widget card. Uses framer-motion `layoutId` for smooth expansion
 * into a popup. Clicking anywhere triggers `onExpand`.
 */
const Widget = forwardRef<HTMLDivElement, WidgetProps>(function Widget(
    { widgetId, title, icon, children, onExpand, className, compact, slim, interactive = true, href, ...motionProps },
    ref
) {
    // Render as an anchor when `href` is set, else a div. Typed loosely so the
    // motion props + click handler aren't constrained to the div/anchor union.
    const Tag = (href ? motion.a : motion.div) as ElementType;
    const linkProps = href ? { href, target: '_blank', rel: 'noopener noreferrer' } : undefined;
    return (
        <Tag
            ref={ref as never}
            layoutId={interactive ? widgetId : undefined}
            className={`${styles.widget} ${compact ? styles.compact : ''} ${slim ? styles.slim : ''} ${interactive ? '' : styles.static} ${className ?? ''}`}
            onClick={interactive && !href ? (e: MouseEvent<HTMLDivElement>) => onExpand?.(e) : undefined}
            whileHover={interactive ? { y: -4 } : undefined}
            whileTap={interactive ? { scale: 0.985 } : undefined}
            transition={{ type: 'spring', stiffness: 300, damping: 26, mass: 0.8 }}
            {...linkProps}
            {...(motionProps as object)}
        >
            {title && (
                <div className={styles.header}>
                    {icon && (
                        <span className={styles.iconWrap}>
                            <span className={`icon icon-${icon} ${styles.icon}`} />
                        </span>
                    )}
                    <span className={styles.title}>{title}</span>
                    {interactive && <span className={`icon icon-arrow ${styles.expandHint}`} aria-hidden='true' />}
                </div>
            )}
            <div className={styles.body}>{children}</div>
        </Tag>
    );
});

export default Widget;
