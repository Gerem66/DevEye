import { type KeyboardEvent, type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { useDismissLayer } from './dismissLayer';
import { DialogPrimaryContext, type RegisterPrimary } from './dialogPrimary';
import { DialogCloseContext } from './dialogClose';
import Button from '@/Components/Button';
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
    /**
     * Primary action of the dialog — pressing Enter (outside a textarea / select /
     * rich-text field) triggers it, so every form dialog confirms on Enter. Wire
     * it to the same handler as the footer's primary button. Content rendered
     * inside a Dialog it doesn't own can register its action via `useDialogSubmit`
     * instead.
     */
    onSubmit?: () => void;
    /**
     * When the dialog opens, move focus to the field marked `data-autofocus`, else
     * the first text field, else the dialog itself (so Enter still works). Set
     * false for dialogs where grabbing focus is undesirable. Defaults to true.
     */
    autoFocus?: boolean;
    /**
     * When true, the dialog holds unsaved changes: any close attempt (overlay /
     * Escape / × / a cancel button wired through {@link useDialogClose}) first
     * pops a confirmation offering Annuler / Quitter sans enregistrer /
     * Enregistrer, so edits are never lost by accident. Requires `onSave`.
     */
    dirty?: boolean;
    /**
     * The dialog's save action, used by the unsaved-changes confirmation's
     * "Enregistrer" choice. Typically the same handler as `onSubmit` / the
     * footer's primary button.
     */
    onSave?: () => void;
}

/** Fields the open-focus should land on (skips checkboxes/radios and selects). */
const FOCUSABLE_FIELD =
    'input:not([type=checkbox]):not([type=radio]):not([type=hidden]), textarea, [contenteditable="true"]';

/**
 * The single modal/dialog used across the app (link codes, 2FA, password forms,
 * confirmations…). Animated glass surface, closes on overlay click or Escape.
 * Feature-specific dialogs render their content as children + footer.
 *
 * Escape is handled through a shared dismiss-layer stack (see {@link useDismissLayer}),
 * so a dialog stacked over a feature panel or another dialog closes that topmost
 * layer only, in tree order. Enter triggers `onSubmit`, and the dialog autofocuses
 * its first field on open — so the behavior is uniform across every popup.
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
    dismissible = true,
    onSubmit,
    autoFocus = true,
    dirty = false,
    onSave
}: DialogProps) {
    const dialogRef = useRef<HTMLDivElement>(null);
    // Whether the "unsaved changes" confirmation is currently shown over this
    // dialog. Only reachable when `dirty` and an `onSave` are provided.
    const [confirmDiscard, setConfirmDiscard] = useState(false);
    const guarded = dirty && !!onSave;

    // A close attempt either pops the confirmation (when dirty) or closes outright.
    const attemptClose = useCallback(() => {
        if (guarded) setConfirmDiscard(true);
        else onClose();
    }, [guarded, onClose]);

    // Once the dialog is gone (or no longer dirty) the confirmation can't linger.
    useEffect(() => {
        if (!open || !guarded) setConfirmDiscard(false);
    }, [open, guarded]);
    // Primary action registered by inner content via useDialogSubmit (fallback
    // when no onSubmit prop is given).
    const contentPrimaryRef = useRef<(() => void) | null>(null);
    const registerPrimary = useCallback<RegisterPrimary>((fn) => {
        contentPrimaryRef.current = fn;
    }, []);

    // Escape closes the topmost layer only. A non-dismissible dialog still pushes
    // a layer (absorbing Escape) so it never leaks to whatever is underneath.
    // While the discard confirmation is up it owns the topmost layer, so Escape
    // there cancels it rather than this dialog.
    useDismissLayer(open, dismissible ? attemptClose : null);

    // Autofocus the main field (or the dialog) once the panel has mounted.
    useEffect(() => {
        if (!open || !autoFocus) return;
        const id = requestAnimationFrame(() => {
            const root = dialogRef.current;
            if (!root) return;
            const target =
                root.querySelector<HTMLElement>('[data-autofocus]') ??
                root.querySelector<HTMLElement>(FOCUSABLE_FIELD) ??
                root;
            target.focus();
        });
        return () => cancelAnimationFrame(id);
    }, [open, autoFocus]);

    const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
        if (e.key !== 'Enter' || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
        const t = e.target as HTMLElement;
        const tag = t.tagName;
        // Newlines and native controls keep their own Enter behavior.
        if (tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'BUTTON' || tag === 'A' || t.isContentEditable) return;
        const primary = onSubmit ?? contentPrimaryRef.current;
        if (!primary) return;
        e.preventDefault();
        primary();
    };

    const discard = () => {
        setConfirmDiscard(false);
        onClose();
    };
    const saveAndClose = () => {
        setConfirmDiscard(false);
        onSave?.();
    };

    // Render through a portal to <body> so every dialog escapes its declaring
    // subtree: its full-screen backdrop always sits at the document root, above
    // any feature popup it was opened from. Clicking the backdrop then dismisses
    // *this* dialog, never a popup underneath — and ancestor transforms (the
    // morphing widget popup) can't shift or clip it.
    const portal = createPortal(
        <AnimatePresence>
            {open && (
                <div className={styles.root}>
                    <motion.div
                        className={styles.overlay}
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        transition={{ duration: 0.2, ease: 'easeOut' }}
                        onClick={dismissible ? attemptClose : undefined}
                    />
                    <motion.div
                        ref={dialogRef}
                        tabIndex={-1}
                        onKeyDown={handleKeyDown}
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
                            <button className={styles.close} onClick={attemptClose} aria-label='Fermer'>
                                <span className='icon icon-x' />
                            </button>
                        </div>
                        {title && <h3 className={styles.title}>{title}</h3>}
                        {description && <p className={styles.description}>{description}</p>}
                        <DialogCloseContext.Provider value={attemptClose}>
                            <DialogPrimaryContext.Provider value={registerPrimary}>
                                <div className={styles.body}>{children}</div>
                            </DialogPrimaryContext.Provider>
                        </DialogCloseContext.Provider>
                        {footer && <div className={styles.footer}>{footer}</div>}
                    </motion.div>
                </div>
            )}
        </AnimatePresence>,
        document.body
    );

    // The unsaved-changes confirmation, normalised here so every dirty Dialog
    // gets the same three-way prompt. It's a plain (non-guarded) Dialog stacked
    // over this one, so it owns the topmost dismiss layer.
    // The confirmation is only ever needed by a dialog that can save, so gate it
    // on `onSave`. This also stops the self-recursion: the confirmation Dialog
    // below carries no `onSave`, so it renders no confirmation of its own.
    return (
        <>
            {portal}
            {onSave && (
                <Dialog
                    open={confirmDiscard}
                    onClose={() => setConfirmDiscard(false)}
                    onSubmit={saveAndClose}
                    title='Modifications non enregistrées'
                    width={460}
                    footer={
                        <>
                            <Button variant='secondary' onClick={() => setConfirmDiscard(false)}>
                                Annuler
                            </Button>
                            <Button variant='danger' onClick={discard}>
                                Quitter sans enregistrer
                            </Button>
                            <Button onClick={saveAndClose}>Enregistrer</Button>
                        </>
                    }
                >
                    <p>Des modifications n’ont pas été enregistrées. Voulez-vous les enregistrer avant de fermer ?</p>
                </Dialog>
            )}
        </>
    );
}
