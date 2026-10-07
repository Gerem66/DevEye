import { type KeyboardEvent, type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence, animate, type AnimationPlaybackControls } from 'framer-motion';
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
    /**
     * A small line above the title: where this dialog sits (the settings
     * trail, « Réglages · Rendez-vous »). The title stays the last step.
     */
    kicker?: ReactNode;
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
     * body becoming the single scroll area once reached. A change of content
     * glides, as in the default layout. Unlike `tall`, which
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

/** Le ressort de toutes les hauteurs du dialogue, mesurées ou suivies. */
const RESIZE_SPRING = { type: 'spring', stiffness: 320, damping: 30, mass: 0.9 } as const;

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
    kicker,
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

    // Hors tall et fill, la hauteur suit le contenu mesuré : `height: 'auto'` n'a
    // pas de valeur cible, et un contenu qui change (onglet, étape) sauterait au
    // lieu de glisser. Plafonnée au `max-height`, au-delà duquel le dialogue défile.
    const contentRef = useRef<HTMLDivElement>(null);
    const [fitHeight, setFitHeight] = useState<number | null>(null);
    const fits = !tall && !fill;
    useLayoutEffect(() => {
        const dialog = dialogRef.current;
        const content = contentRef.current;
        if (!open || !fits || !dialog || !content) return;
        const sync = () => {
            const cs = getComputedStyle(dialog);
            const chrome =
                parseFloat(cs.paddingTop) +
                parseFloat(cs.paddingBottom) +
                parseFloat(cs.borderTopWidth) +
                parseFloat(cs.borderBottomWidth);
            setFitHeight(Math.min(content.offsetHeight + chrome, parseFloat(cs.maxHeight) || Infinity));
        };
        sync();
        const ro = new ResizeObserver(sync);
        ro.observe(content);
        window.addEventListener('resize', sync);
        return () => {
            ro.disconnect();
            window.removeEventListener('resize', sync);
            // Le prochain contenu (le dialogue d'info en porte plusieurs) repart de sa propre hauteur.
            setFitHeight(null);
        };
    }, [open, fits]);
    const height = tall ? tallHeight : fits && fitHeight !== null ? fitHeight : 'auto';

    // En fill, la boîte reste en `auto` (son contenu dicte sa colonne flex) : on
    // la rattrape après coup. L'observateur passe après la mise en page et avant
    // la peinture, donc le saut n'est jamais peint : la hauteur repart de
    // l'ancienne, glisse vers la nouvelle, puis rend la main à `auto`.
    useLayoutEffect(() => {
        const dialog = dialogRef.current;
        if (!open || !fill || !dialog) return;
        let last: number | null = null;
        let running: AnimationPlaybackControls | null = null;
        const ro = new ResizeObserver(() => {
            // Pendant le glissement, la hauteur est posée : seul le glissement la bouge.
            if (running) return;
            const next = dialog.offsetHeight;
            const from = last;
            last = next;
            if (from === null || Math.abs(next - from) < 1) return;
            dialog.style.height = `${from}px`;
            dialog.setAttribute('data-resizing', '');
            const run = animate(dialog, { height: next }, RESIZE_SPRING);
            running = run;
            void run.then(() => {
                if (running !== run) return;
                running = null;
                // Un contenu changé pendant le glissement relance l'observateur ici.
                dialog.style.height = '';
                dialog.removeAttribute('data-resizing');
            });
        });
        ro.observe(dialog);
        return () => {
            ro.disconnect();
            running?.stop();
            running = null;
            dialog.style.height = '';
            dialog.removeAttribute('data-resizing');
        };
    }, [open, fill]);

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
        // React remonte l'Entrée d'un portail enfant (confirmation, liste) jusqu'ici :
        // elle appartient à ce portail, ce dialogue ne doit pas se valider avec lui.
        if (!e.currentTarget.contains(t)) return;
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
                        initial={{ opacity: 0, scale: 0.94, maxWidth: width, height }}
                        animate={{ opacity: 1, scale: 1, maxWidth: width, height }}
                        exit={{ opacity: 0, scale: 0.94 }}
                        transition={RESIZE_SPRING}
                        // Pendant qu'elle grandit, la boîte est plus courte que son
                        // contenu : sans ce drapeau, une barre de défilement clignoterait.
                        onAnimationStart={() => dialogRef.current?.setAttribute('data-resizing', '')}
                        onAnimationComplete={() => dialogRef.current?.removeAttribute('data-resizing')}
                    >
                        <div className={styles.corner}>
                            {headerAction}
                            {closeButton && (
                                <button className={styles.close} onClick={attemptClose} aria-label='Fermer'>
                                    <span className='icon icon-x' />
                                </button>
                            )}
                        </div>
                        <div ref={contentRef} className={fits ? styles.measure : styles.passthrough}>
                            {kicker && <div className={styles.kicker}>{kicker}</div>}
                            {title && <h3 className={styles.title}>{title}</h3>}
                            {description && <p className={styles.description}>{description}</p>}
                            {/* Le pied aussi : un `DialogCancelButton` y est le cas courant. */}
                            <DialogCloseContext.Provider value={attemptClose}>
                                <DialogPrimaryContext.Provider value={registerPrimary}>
                                    <div className={`${styles.body} ${tall || fill ? styles.bodyFill : ''}`}>
                                        {children}
                                    </div>
                                </DialogPrimaryContext.Provider>
                                {footer && <div className={styles.footer}>{footer}</div>}
                            </DialogCloseContext.Provider>
                        </div>
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
