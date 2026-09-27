import { createContext, type ReactNode } from 'react';

/** La vue qui héberge un écran : ce qui borne ses `useSubView` à elle. */
export const ViewScopeContext = createContext<string | null>(null);

export function ViewScope({ id, children }: { id: string; children: ReactNode }) {
    return <ViewScopeContext.Provider value={id}>{children}</ViewScopeContext.Provider>;
}
