import { type ReactNode, useEffect } from 'react';
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
    /** Max dialog width in px. */
    width?: number;
}

/**
 * The single modal/dialog used across the app (link codes, 2FA, password forms,
 * confirmations…). Animated glass surface, closes on overlay click or Escape.
 * Feature-specific dialogs render their content as children + footer.
 */
export default function Dialog({ open, onClose, title, description, children, footer, width = 460 }: DialogProps) {
    useEffect(() => {
        if (!open) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [open, onClose]);

    return (
        <AnimatePresence>
            {open && (
                <div className={styles.root}>
                    <motion.div
                        className={styles.overlay}
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        transition={{ duration: 0.2, ease: 'easeOut' }}
                        onClick={onClose}
                    />
                    <motion.div
                        className={styles.dialog}
                        style={{ maxWidth: width }}
                        role='dialog'
                        aria-modal='true'
                        initial={{ opacity: 0, scale: 0.94, y: 16 }}
                        animate={{ opacity: 1, scale: 1, y: 0 }}
                        exit={{ opacity: 0, scale: 0.94, y: 16 }}
                        transition={{ type: 'spring', stiffness: 320, damping: 30, mass: 0.9 }}
                    >
                        <button className={styles.close} onClick={onClose} aria-label='Fermer'>
                            <span className='icon icon-x' />
                        </button>
                        {title && <h3 className={styles.title}>{title}</h3>}
                        {description && <p className={styles.description}>{description}</p>}
                        <div className={styles.body}>{children}</div>
                        {footer && <div className={styles.footer}>{footer}</div>}
                    </motion.div>
                </div>
            )}
        </AnimatePresence>
    );
}
