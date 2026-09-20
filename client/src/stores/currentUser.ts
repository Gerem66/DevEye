import { useSyncExternalStore } from 'react';
import type { User } from '@deveye/types';

/**
 * L'utilisateur connecté, tel que la session l'a livré. Séparé du fournisseur
 * d'authentification exprès : le barrel des modules doit pouvoir dire « qui je
 * suis » sans tirer `AuthProvider` et tout ce qu'il importe. `AuthProvider` y
 * écrit, les écrans y lisent.
 *
 * Dans un espace d'une instance distante, « qui je suis » est le compte ouvert
 * LÀ-BAS (`acting`) : c'est son id que portent les membres, les curseurs et les
 * droits de cet espace, pas celui du compte d'ici.
 */
let local: User | null = null;
let acting: User | null = null;
const listeners = new Set<() => void>();

function emit(): void {
    for (const fn of listeners) fn();
}

function subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

export function setCurrentUser(user: User | null): void {
    local = user;
    emit();
}

/** Le compte de l'instance distante où l'on se trouve ; `null` de retour ici. */
export function setActingUser(user: User | null): void {
    if (acting === user) return;
    acting = user;
    emit();
}

export function getCurrentUser(): User | null {
    return acting ?? local;
}

/** Le compte de CETTE instance, où que l'on se trouve. */
export function getLocalUser(): User | null {
    return local;
}

const getActingUser = (): User | null => acting;

export function useCurrentUser(): User | null {
    return useSyncExternalStore(subscribe, getCurrentUser, getCurrentUser);
}

export function useActingUser(): User | null {
    return useSyncExternalStore(subscribe, getActingUser, getActingUser);
}
