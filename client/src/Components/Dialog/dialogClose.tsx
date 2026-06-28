import { createContext, useContext } from 'react';

import Button, { type ButtonProps } from '@/Components/Button';

/**
 * Lets content inside a Dialog request a *guarded* close — the same path the
 * overlay click / Escape / × take. When the Dialog is marked dirty it routes the
 * request through the "unsaved changes" confirmation instead of closing outright,
 * so a feature's own "Annuler / Fermer" button gets the guard for free.
 *
 * Defaults to a no-op so a component that renders outside a Dialog still works.
 */
export const DialogCloseContext = createContext<() => void>(() => {});

/** Request the enclosing Dialog's guarded close (see {@link DialogCloseContext}). */
export function useDialogClose(): () => void {
    return useContext(DialogCloseContext);
}

/**
 * A feature's "Annuler / Fermer" button that closes through the enclosing
 * Dialog's guard, so it triggers the unsaved-changes prompt just like the ×,
 * overlay and Escape do. Must be rendered inside the Dialog (i.e. as Popup
 * content), not in the component that renders the Dialog. Defaults to a secondary
 * "Annuler"; pass `children` for a different label.
 */
export function DialogCancelButton({ variant = 'secondary', children = 'Annuler', ...rest }: ButtonProps) {
    const close = useDialogClose();
    return (
        <Button variant={variant} onClick={close} {...rest}>
            {children}
        </Button>
    );
}
