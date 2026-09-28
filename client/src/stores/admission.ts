import { useSyncExternalStore } from 'react';

/**
 * Où en est l'entrée de ce compte sur ce serveur, quand des places simultanées
 * le font attendre : en file, ou sa place rendue après une longue inactivité.
 * `null` : il est entré, ou rien ne le retient.
 */
export type Admission = { kind: 'queued'; position: number } | { kind: 'released' } | null;

let current: Admission = null;
const listeners = new Set<() => void>();

export function setAdmission(next: Admission): void {
    if (
        next === current ||
        (next?.kind === 'queued' && current?.kind === 'queued' && next.position === current.position)
    ) {
        return;
    }
    current = next;
    for (const fn of listeners) fn();
}

const subscribe = (fn: () => void): (() => void) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
};

const get = (): Admission => current;

export function useAdmission(): Admission {
    return useSyncExternalStore(subscribe, get, get);
}
