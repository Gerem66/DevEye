import { type ReactNode } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useDismissLayer } from '@/Components/Dialog';
import { usePopupMaxWidth } from '@/stores/popupWidth';
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
 * Full-screen feature panel that morphs from the originating Widget via
 * framer-motion's `layoutId`. No header of its own: the TopNavbar stays above
 * and owns the back action + title. The panel mounts/unmounts with `open` so
 * the morph plays both ways; feature content is kept alive by being portaled
 * into `bodyRef` from the dashboard.
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

    // Horizontal views ask for the width they need (see `stores/popupWidth`),
    // clamped to the viewport. A CSS transition rather than an animated style
    // prop, so framer-motion (which owns this element through `layoutId`) sees
    // no layout jump to reconcile.
    const maxWidth = usePopupMaxWidth();

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
                        /*
                         * Une prise pour le contenu qui doit se mesurer contre le
                         * cadre (voir `stores/popupWidth`), atteint par un portail.
                         * Un attribut plutôt qu'une classe : un nom de classe de
                         * module CSS n'est pas un contrat stable.
                         */
                        data-popup-frame=''
                        style={{ maxWidth }}
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
