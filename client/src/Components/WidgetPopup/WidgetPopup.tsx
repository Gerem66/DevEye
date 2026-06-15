import { type ReactNode, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import styles from './WidgetPopup.module.css';

export interface WidgetPopupProps {
    /** Must match the widget's `widgetId` for the shared-element animation. */
    layoutId: string;
    /** Whether the popup is currently shown. */
    open: boolean;
    /** Called when the user requests to close (back button, escape, overlay click). */
    onClose: () => void;
    /** Title displayed in the popup header. */
    title?: string;
    /** Icon class name for the header. */
    icon?: string;
    /** Popup content. */
    children?: ReactNode;
}

/**
 * Full-screen (with padding) popup that animates from the originating Widget via
 * framer-motion's `layoutId`. The overlay fades in; the content morphs.
 */
export default function WidgetPopup({ layoutId, open, onClose, title, icon, children }: WidgetPopupProps) {
    // Close on Escape
    useEffect(() => {
        if (!open) return;
        const handler = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose();
        };
        window.addEventListener('keydown', handler);
        return () => window.removeEventListener('keydown', handler);
    }, [open, onClose]);

    return (
        <AnimatePresence>
            {open && (
                <>
                    {/* Overlay */}
                    <motion.div
                        className={styles.overlay}
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        transition={{ duration: 0.2 }}
                        onClick={onClose}
                    />

                    {/* Popup content */}
                    <motion.div
                        layoutId={layoutId}
                        className={styles.popup}
                        transition={{ type: 'spring', stiffness: 350, damping: 35 }}
                    >
                        <header className={styles.header}>
                            <button className={styles.backBtn} onClick={onClose} aria-label='Retour'>
                                <span className='icon-arrow-left' />
                            </button>
                            {icon && <span className={`icon-${icon} ${styles.icon}`} />}
                            {title && <h2 className={styles.title}>{title}</h2>}
                        </header>
                        <div className={styles.body}>{children}</div>
                    </motion.div>
                </>
            )}
        </AnimatePresence>
    );
}
