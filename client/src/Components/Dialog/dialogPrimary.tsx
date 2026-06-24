import { createContext, useContext, useEffect, useRef } from 'react';

/** Registers (or clears, with null) the dialog's primary action. */
export type RegisterPrimary = (fn: (() => void) | null) => void;

/**
 * Lets a Dialog expose a slot for its primary action so the Enter key can trigger
 * it. Most popups own their Dialog and pass `onSubmit` directly; this context is
 * for forms rendered *inside* a Dialog owned by another component (e.g. the
 * shortcut form in the add-tile dialog), which register their own submit here.
 */
export const DialogPrimaryContext = createContext<RegisterPrimary | null>(null);

/**
 * Register `fn` as the enclosing Dialog's primary action (triggered by Enter).
 * Use from a content component that owns its submit but not the Dialog. The
 * function is read through a ref, so an inline closure won't thrash registration.
 */
export function useDialogSubmit(fn: (() => void) | null): void {
    const register = useContext(DialogPrimaryContext);
    const ref = useRef(fn);
    ref.current = fn;
    useEffect(() => {
        if (!register) return;
        register(() => ref.current?.());
        return () => register(null);
    }, [register]);
}
