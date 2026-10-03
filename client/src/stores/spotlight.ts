import { useSyncExternalStore } from 'react';

/**
 * La recherche des fonctionnalités : ouverte par une frappe sur l'accueil ou par
 * la loupe de la topbar. `seed` est la saisie de départ, la lettre qui l'a ouverte.
 */
interface Spotlight {
    open: boolean;
    seed: string;
}

const CLOSED: Spotlight = { open: false, seed: '' };

let state: Spotlight = CLOSED;
const listeners = new Set<() => void>();

function emit(): void {
    for (const fn of listeners) fn();
}

function subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => {
        listeners.delete(fn);
    };
}

export function useSpotlight(): Spotlight {
    return useSyncExternalStore(
        subscribe,
        () => state,
        () => state
    );
}

export function isSpotlightOpen(): boolean {
    return state.open;
}

export function openSpotlight(seed = ''): void {
    if (state.open) return;
    state = { open: true, seed };
    emit();
}

export function closeSpotlight(): void {
    if (state === CLOSED) return;
    state = CLOSED;
    emit();
}
