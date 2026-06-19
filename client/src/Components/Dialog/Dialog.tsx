import { type ReactNode, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import styles from './Dialog.module.css';

export interface DialogProps {
    /** Whether the dialog is shown. */
    open: boolean;
    /** Called on overlay click / Escape / close button. */
    onClose: () => void;
    /** Heading shown at the top. */
    title?: string;
    /** Optional sub-text under the title. */
    description?: ReactNode;
    /** Dialog body. */
    children?: ReactNode;
    /** Optional footer, typically action buttons. */
    footer?: ReactNode;
    /**
     * Optional action rendered in the top-right corner, just left of the close
     * button (e.g. an "i" info button). The Dialog owns the corner geometry, so
     * it never collides with the × — features must not position it themselves.
     */
    headerAction?: ReactNode;
    /** Max dialog width in px. */
    width?: number;
    /**
     * When false, the overlay click and Escape no longer close the dialog (only
     * the close button / explicit actions do). Use for dialogs where an
     * accidental dismissal is costly — e.g. 2FA setup, which mints a fresh
     * secret each time it opens. Defaults to true.
     */
    dismissible?: boolean;
}

/**
 * The single modal/dialog used across the app (link codes, 2FA, password forms,
 * confirmations…). Animated glass surface, closes on overlay click or Escape.
 * Feature-specific dialogs render their content as children + footer.
 */
export default function Dialog({
    open,
    onClose,
    title,
    description,
    children,
    footer,
    headerAction,
    width = 460,
    dismissible = true
}: DialogProps) {
    useEffect(() => {
        if (!open || !dismissible) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [open, onClose, dismissible]);

    // Render through a portal to <body> so every dialog escapes its declaring
    // subtree: its full-screen backdrop always sits at the document root, above
    // any feature popup it was opened from. Clicking the backdrop then dismisses
    // *this* dialog, never a popup underneath — and ancestor transforms (the
    // morphing widget popup) can't shift or clip it.
    return createPortal(
        <AnimatePresence>
            {open && (
                <div className={styles.root}>
                    <motion.div
                        className={styles.overlay}
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        transition={{ duration: 0.2, ease: 'easeOut' }}
                        onClick={dismissible ? onClose : undefined}
                    />
                    <motion.div
                        className={styles.dialog}
                        style={{ maxWidth: width }}
                        role='dialog'
                        aria-modal='true'
                        initial={{ opacity: 0, scale: 0.94, y: 0 }}
                        animate={{ opacity: 1, scale: 1, y: 0 }}
                        exit={{ opacity: 0, scale: 0.94, y: 0 }}
                        transition={{ type: 'spring', stiffness: 320, damping: 30, mass: 0.9 }}
                    >
                        <div className={styles.corner}>
                            {headerAction}
                            <button className={styles.close} onClick={onClose} aria-label='Fermer'>
                                <span className='icon icon-x' />
                            </button>
                        </div>
                        {title && <h3 className={styles.title}>{title}</h3>}
                        {description && <p className={styles.description}>{description}</p>}
                        <div className={styles.body}>{children}</div>
                        {footer && <div className={styles.footer}>{footer}</div>}
                    </motion.div>
                </div>
            )}
        </AnimatePresence>,
        document.body
    );
}
