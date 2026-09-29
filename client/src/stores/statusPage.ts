import { useSyncExternalStore } from 'react';
import { serverStatusSchema } from '@deveye/types';

import { getLocal } from '@/api/http';

/**
 * La page d'état publique de ce serveur (`STATUS_PAGE_URL`), qui reste
 * joignable quand lui ne l'est plus : lue au démarrage, gardée pour le moment
 * où elle sert. `null` tant qu'elle n'est pas connue, et sur un serveur sans page.
 */
const RETRY_MS = 30_000;

let url: string | null = null;
let started = false;
const listeners = new Set<() => void>();

async function load(): Promise<void> {
    try {
        const status = await getLocal('/api/status', serverStatusSchema);
        url = status.statusPageUrl;
        for (const fn of listeners) fn();
    } catch {
        setTimeout(() => void load(), RETRY_MS);
    }
}

/** À l'ouverture de l'app : l'adresse doit être là avant que le serveur ne réponde plus. */
export function primeStatusPage(): void {
    if (started) return;
    started = true;
    void load();
}

function subscribe(fn: () => void): () => void {
    listeners.add(fn);
    primeStatusPage();
    return () => listeners.delete(fn);
}

/** L'adresse de la page d'état, sur la fonctionnalité donnée s'il y en a une. */
export function useStatusPageHref(featureId?: string | null): string | null {
    const base = useSyncExternalStore(
        subscribe,
        () => url,
        () => url
    );
    if (base === null) return null;
    return featureId ? `${base}/${encodeURIComponent(featureId)}` : base;
}
