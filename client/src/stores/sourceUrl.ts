import { useSyncExternalStore } from 'react';

/**
 * Le code source de ce serveur (`SOURCE_URL`), que l'AGPL demande d'offrir à
 * qui s'en sert en ligne. Livré par le bundle de session ; `null` : aucun lien.
 */
let sourceUrl: string | null = null;
const listeners = new Set<() => void>();

export function setSourceUrl(value: string | null): void {
    if (value === sourceUrl) return;
    sourceUrl = value;
    for (const fn of listeners) fn();
}

function getSourceUrl(): string | null {
    return sourceUrl;
}

export function useSourceUrl(): string | null {
    return useSyncExternalStore(
        (fn) => {
            listeners.add(fn);
            return () => listeners.delete(fn);
        },
        getSourceUrl,
        getSourceUrl
    );
}
