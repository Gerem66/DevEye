import { type ReactNode } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useDismissLayer } from '@/Components/Dialog';
import { usePopupWide } from '@/stores/popupWidth';
import { useSecrecyHold } from '@/stores/secrecy';
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
    /**
     * Hold the password-encryption DEK alive while this panel is open — set for
     * feature views that read/write encrypted data (notes, passwords) so a long
     * edit never trips the re-validation prompt. A fresh window restarts on close.
     */
    holdSecrecy?: boolean;
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
export default function WidgetPopup({
    layoutId,
    open,
    onClose,
    bodyRef,
    onExitComplete,
    holdSecrecy,
    children
}: WidgetPopupProps) {
    // Escape closes the topmost layer only: a dialog opened over the feature panel
    // closes first, then a second Escape closes the panel itself (tree order).
    useDismissLayer(open, onClose);

    // Keep the encrypted DEK alive for sensitive feature views while open.
    useSecrecyHold(Boolean(open && holdSecrecy));

    // Horizontal views (kanban, timeline…) can ask for the full width. The
    // change rides a CSS transition rather than a style prop so framer-motion —
    // which owns this element through `layoutId` — sees no layout jump to
    // reconcile at render time, and the growth stays smooth on its own.
    const wide = usePopupWide();

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
                        className={`${styles.popup} ${wide ? styles.popupWide : ''}`}
                        initial={layoutId ? false : { opacity: 0, scale: 0.95 }}
                        animate={layoutId ? undefined : { opacity: 1, scale: 1 }}
                        exit={layoutId ? undefined : { opacity: 0, scale: 0.95 }}
                        transition={{ type: 'spring', stiffness: 280, damping: 32, mass: 0.9 }}
                    >
                        <div className={styles.body}>
                            <div className={styles.scroll} ref={bodyRef}>
                                {children}
                            </div>
                        </div>
                    </motion.div>
                </>
            )}
        </AnimatePresence>
    );
}
