import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

/**
 * L'endroit où les bandeaux d'erreur d'un cadre se rangent : sous l'en-tête
 * collant d'une vue, sous le titre d'un dialogue. Un bandeau s'y affiche par un
 * portail, où que l'appelant l'ait posé ; sans emplacement, il reste en place.
 */
interface ErrorSlotScope {
    slot: HTMLElement | null;
    /** Offert par une vue : son `StickyHeader` y déclare l'emplacement. Un dialogue a le sien. */
    register: ((element: HTMLElement) => () => void) | null;
}

const ErrorSlotContext = createContext<ErrorSlotScope>({ slot: null, register: null });

/** Le cadre d'une vue de la popup : l'emplacement est celui de son `StickyHeader`. */
export function ErrorSlotViewScope({ children }: { children: ReactNode }) {
    const [slot, setSlot] = useState<HTMLElement | null>(null);
    const register = useCallback((element: HTMLElement) => {
        setSlot(element);
        return () => setSlot((held) => (held === element ? null : held));
    }, []);
    const scope = useMemo(() => ({ slot, register }), [slot, register]);
    return <ErrorSlotContext.Provider value={scope}>{children}</ErrorSlotContext.Provider>;
}

/** Le cadre d'un dialogue : l'emplacement est fixe, et un en-tête de vue hébergée ne le prend pas. */
export function ErrorSlotFixedScope({ slot, children }: { slot: HTMLElement | null; children: ReactNode }) {
    const scope = useMemo(() => ({ slot, register: null }), [slot]);
    return <ErrorSlotContext.Provider value={scope}>{children}</ErrorSlotContext.Provider>;
}

export function useErrorSlot(): HTMLElement | null {
    return useContext(ErrorSlotContext).slot;
}

export function useErrorSlotRegister(): ErrorSlotScope['register'] {
    return useContext(ErrorSlotContext).register;
}
