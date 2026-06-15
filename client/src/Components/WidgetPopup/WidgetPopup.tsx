import { type ReactNode, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import styles from './WidgetPopup.module.css';

export interface WidgetPopupProps {
    /** Must match the widget's `widgetId` for the shared-element animation. */
    layoutId: string;
    /** Whether the popup is currently shown. */
    open: boolean;
    /** Called when the user requests to close (Escape, overlay click). */
    onClose: () => void;
    /** Popup content (the feature provides its own heading). */
    children?: ReactNode;
}

/**
 * Full-screen feature panel that animates from the originating Widget via
 * framer-motion's `layoutId`. It deliberately has no header of its own: the
 * TopNavbar stays above it (higher z-index) and owns the back action + title,
 * so the topbar always provides the main context. Closes on Escape / overlay.
 */
export default function WidgetPopup({ layoutId, open, onClose, children }: WidgetPopupProps) {
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
                    {/* Overlay (below the navbar — navbar stays bright & clickable) */}
                    <motion.div
                        className={styles.overlay}
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        transition={{ duration: 0.2 }}
                        onClick={onClose}
                    />

                    {/* Panel */}
                    <motion.div
                        layoutId={layoutId}
                        className={styles.popup}
                        transition={{ type: 'spring', stiffness: 350, damping: 35 }}
                    >
                        <div className={styles.body}>{children}</div>
                    </motion.div>
                </>
            )}
        </AnimatePresence>
    );
}
