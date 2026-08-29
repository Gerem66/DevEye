import { createContext, useContext } from 'react';

import Button, { type ButtonProps } from '@/Components/Button';

/**
 * Lets content inside a Dialog request a guarded close, the same path the
 * overlay click / Escape / × take: when the Dialog is dirty it routes through
 * the unsaved-changes confirmation. Defaults to a no-op outside a Dialog.
 */
export const DialogCloseContext = createContext<() => void>(() => {});

/** Request the enclosing Dialog's guarded close (see {@link DialogCloseContext}). */
export function useDialogClose(): () => void {
    return useContext(DialogCloseContext);
}

/**
 * A feature's "Annuler / Fermer" button closing through the enclosing Dialog's
 * guard. Must be rendered inside the Dialog (as Popup content). Defaults to a
 * secondary "Annuler".
 */
export function DialogCancelButton({ variant = 'secondary', children = 'Annuler', ...rest }: ButtonProps) {
    const close = useDialogClose();
    return (
        <Button variant={variant} onClick={close} {...rest}>
            {children}
        </Button>
    );
}
