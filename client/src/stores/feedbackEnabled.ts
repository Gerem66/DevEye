import { useSyncExternalStore } from 'react';

/**
 * Ce serveur accepte-t-il les signalements (`FEEDBACK_ENABLED`) ? Livré par le
 * bundle de session, que `AuthProvider` verse ici : le bouton et l'entrée
 * d'administration s'affichent au premier rendu, sans requête ni clignotement.
 *
 * Faux par défaut, comme le serveur : tant qu'on ne sait pas, on ne propose pas.
 */
let enabled = false;
const listeners = new Set<() => void>();

export function setFeedbackEnabled(value: boolean): void {
    if (value === enabled) return;
    enabled = value;
    for (const fn of listeners) fn();
}

export function getFeedbackEnabled(): boolean {
    return enabled;
}

export function useFeedbackEnabled(): boolean {
    return useSyncExternalStore(
        (fn) => {
            listeners.add(fn);
            return () => listeners.delete(fn);
        },
        getFeedbackEnabled,
        getFeedbackEnabled
    );
}
