import { useEffect, useSyncExternalStore } from 'react';

/**
 * Les vues qui éteignent les curseurs de DevEye : un canevas qu'on déplace et
 * qu'on zoome, où un point rapporté à la popup ne désigne rien, et qui dessine
 * ses propres pointeurs. Un compteur : deux vues montées à la fois ne se
 * rallument pas l'une l'autre en se démontant.
 */
let holders = 0;
const listeners = new Set<() => void>();

function notify(): void {
    for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

/** `true` tant qu'une vue montée éteint les curseurs. */
export function useLiveCursorsSuppressed(): boolean {
    return useSyncExternalStore(
        subscribe,
        () => holders > 0,
        () => false
    );
}

/**
 * Éteint, tant que la vue est montée et `active` vrai, l'émission de son curseur
 * comme l'affichage de ceux des pairs, et la bulle avec eux. Le roster, les
 * contours et « en train d'écrire » restent.
 */
export function useSuppressLiveCursors(active = true): void {
    useEffect(() => {
        if (!active) return;
        holders += 1;
        notify();
        return () => {
            holders -= 1;
            notify();
        };
    }, [active]);
}
