import { useSyncExternalStore } from 'react';
import type { User } from '@deveye/types';

/**
 * L'utilisateur connecté, tel que la session l'a livré. Séparé du fournisseur
 * d'authentification exprès : le barrel des modules doit pouvoir dire « qui je
 * suis » sans tirer `AuthProvider` et tout ce qu'il importe. `AuthProvider` y
 * écrit, les écrans y lisent.
 */
let current: User | null = null;
const listeners = new Set<() => void>();

export function setCurrentUser(user: User | null): void {
    current = user;
    for (const fn of listeners) fn();
}

export function getCurrentUser(): User | null {
    return current;
}

export function useCurrentUser(): User | null {
    return useSyncExternalStore(
        (fn) => {
            listeners.add(fn);
            return () => listeners.delete(fn);
        },
        getCurrentUser,
        getCurrentUser
    );
}
