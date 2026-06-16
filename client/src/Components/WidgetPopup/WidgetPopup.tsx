import { type ReactNode, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import styles from './WidgetPopup.module.css';

export interface WidgetPopupProps {
    /**
     * Grid card `widgetId` to morph from via framer-motion's shared-element
     * transition. Omit for views with no card (structural pages) — the panel
     * then fades + scales in instead.
     */
    layoutId?: string;
    /** Whether the popup is currently shown. */
    open: boolean;
    /** Called when the user requests to close (Escape, overlay click). */
    onClose: () => void;
    /**
     * Receives the panel body element. The dashboard portals the (kept-alive)
     * feature content into it, so the feature's React state survives close.
     */
    bodyRef?: (el: HTMLDivElement | null) => void;
    /** Called once the close (exit) animation has fully completed. */
    onExitComplete?: () => void;
    /** Optional fallback content rendered directly in the body. */
    children?: ReactNode;
}

/**
 * Full-screen feature panel that animates from the originating Widget via
 * framer-motion's `layoutId`. It deliberately has no header of its own: the
 * TopNavbar stays above it (higher z-index) and owns the back action + title,
 * so the topbar always provides the main context. Closes on Escape / overlay.
 *
 * The panel itself mounts/unmounts with `open` (so the shared-element morph
 * plays both ways). Feature *content* is kept alive across opens by portaling
 * it into `bodyRef` from the dashboard, rather than being a normal child here.
 */
export default function WidgetPopup({ layoutId, open, onClose, bodyRef, onExitComplete, children }: WidgetPopupProps) {
    useEffect(() => {
        if (!open) return;
        const handler = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose();
        };
        window.addEventListener('keydown', handler);
        return () => window.removeEventListener('keydown', handler);
    }, [open, onClose]);

    return (
        <AnimatePresence onExitComplete={onExitComplete}>
            {open && (
                <>
                    {/* Overlay (below the navbar — navbar stays bright & clickable) */}
                    <motion.div
                        className={styles.overlay}
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        transition={{ duration: 0.28, ease: 'easeOut' }}
                        onClick={onClose}
                    />

                    {/* Panel — morphs from the grid card when a `layoutId` is
                        given, otherwise fades + scales in (structural pages). */}
                    <motion.div
                        layoutId={layoutId}
                        className={styles.popup}
                        initial={layoutId ? false : { opacity: 0, scale: 0.97, y: 12 }}
                        animate={layoutId ? undefined : { opacity: 1, scale: 1, y: 0 }}
                        exit={layoutId ? undefined : { opacity: 0, scale: 0.97, y: 12 }}
                        transition={{ type: 'spring', stiffness: 280, damping: 32, mass: 0.9 }}
                    >
                        <div className={styles.body} ref={bodyRef}>
                            {children}
                        </div>
                    </motion.div>
                </>
            )}
        </AnimatePresence>
    );
}
