import { type KeyboardEvent, type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { useDismissLayer } from './dismissLayer';
import { DialogPrimaryContext, type RegisterPrimary } from './dialogPrimary';
import { DialogCloseContext } from './dialogClose';
import Button from '@/Components/Button';
import { useSecrecyHold } from '@/stores/secrecy';
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
     * When false, overlay click and Escape no longer close the dialog (only the
     * close button / explicit actions do): for dialogs where an accidental
     * dismissal is costly, e.g. 2FA setup. Defaults to true.
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
    /**
     * Lay the dialog out at a fixed, viewport-tall height as a flex column: the
     * title and footer stay pinned and the body becomes the single scroll area.
     * Used by surfaces that switch to a large editor for long content.
     */
    tall?: boolean;
    /**
     * Let the dialog's height follow its content up to the viewport cap, the
     * body becoming the single scroll area once reached. Unlike `tall`, which
     * pins the full viewport height whatever the content. The content claims
     * the leftover space itself (`flex: 1` down to the scrollable region).
     */
    fill?: boolean;
    /**
     * Hold the password-encryption DEK alive while this dialog is open: a long
     * edit never trips the re-validation prompt mid-action, and a fresh window
     * restarts when it closes. No-op when the feature is off / locked.
     */
    holdSecrecy?: boolean;
    /**
     * Sans le bouton de fermeture : un dialogue de progression, que rien ne
     * ferme tant que l'opération dure. Défaut `true`.
     */
    closeButton?: boolean;
}

/** Fields the open-focus should land on (skips checkboxes/radios and selects). */
const FOCUSABLE_FIELD =
    'input:not([type=checkbox]):not([type=radio]):not([type=hidden]), textarea, [contenteditable="true"]';

/** Pixel height of the "tall" layout: the viewport minus the dialog's margins. */
function viewportTall(): number {
    const lg = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--space-lg'), 10) || 24;
    return window.innerHeight - 2 * lg;
}

/**
 * The single modal used across the app. Escape goes through the shared
 * dismiss-layer stack (see {@link useDismissLayer}), so a stacked dialog closes
 * the topmost layer only; Enter triggers `onSubmit`; the first field is
 * autofocused on open.
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
    onSave,
    tall = false,
    fill = false,
    holdSecrecy = false,
    closeButton = true
}: DialogProps) {
    const dialogRef = useRef<HTMLDivElement>(null);

    // Keep the encrypted DEK alive while this dialog stays open (no-op unless
    // password encryption is on). Released on close/unmount → fresh grace window.
    useSecrecyHold(open && holdSecrecy);
    // Whether the "unsaved changes" confirmation is currently shown over this
    // dialog. Only reachable when `dirty` and an `onSave` are provided.
    const [confirmDiscard, setConfirmDiscard] = useState(false);
    const guarded = dirty && !!onSave;

    // Target height for the tall layout, kept in sync with the viewport so the
    // size switch can animate to a concrete value.
    const [tallHeight, setTallHeight] = useState(viewportTall);
    useEffect(() => {
        const onResize = () => setTallHeight(viewportTall());
        window.addEventListener('resize', onResize);
        return () => window.removeEventListener('resize', onResize);
    }, []);

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

    // Portal to <body>: the backdrop always sits at the document root, above any
    // feature popup, and ancestor transforms (the morphing widget popup) can't
    // shift or clip it.
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
                        className={`${styles.dialog} ${tall ? styles.dialogTall : ''} ${fill ? styles.dialogFill : ''}`}
                        role='dialog'
                        aria-modal='true'
                        initial={{ opacity: 0, scale: 0.94, maxWidth: width, height: tall ? tallHeight : 'auto' }}
                        animate={{ opacity: 1, scale: 1, maxWidth: width, height: tall ? tallHeight : 'auto' }}
                        exit={{ opacity: 0, scale: 0.94 }}
                        transition={{ type: 'spring', stiffness: 320, damping: 30, mass: 0.9 }}
                    >
                        <div className={styles.corner}>
                            {headerAction}
                            {closeButton && (
                                <button className={styles.close} onClick={attemptClose} aria-label='Fermer'>
                                    <span className='icon icon-x' />
                                </button>
                            )}
                        </div>
                        {title && <h3 className={styles.title}>{title}</h3>}
                        {description && <p className={styles.description}>{description}</p>}
                        <DialogCloseContext.Provider value={attemptClose}>
                            <DialogPrimaryContext.Provider value={registerPrimary}>
                                <div className={`${styles.body} ${tall || fill ? styles.bodyFill : ''}`}>
                                    {children}
                                </div>
                            </DialogPrimaryContext.Provider>
                        </DialogCloseContext.Provider>
                        {footer && <div className={styles.footer}>{footer}</div>}
                    </motion.div>
                </div>
            )}
        </AnimatePresence>,
        document.body
    );

    // The unsaved-changes confirmation: a plain Dialog stacked over this one, so
    // it owns the topmost dismiss layer. Gated on `onSave`, which also stops the
    // recursion: the confirmation carries no `onSave`.
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
