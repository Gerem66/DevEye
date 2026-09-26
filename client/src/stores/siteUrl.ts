import { useSyncExternalStore } from 'react';

/**
 * Le site vitrine de ce DevEye (`SITE_URL`), où vivent ses pages légales.
 * Livré par le bundle de session, comme `feedbackEnabled` ; `null` sur une
 * installation sans site : aucun lien légal ne s'affiche alors.
 */
let siteUrl: string | null = null;
const listeners = new Set<() => void>();

export function setSiteUrl(value: string | null): void {
    if (value === siteUrl) return;
    siteUrl = value;
    for (const fn of listeners) fn();
}

export function getSiteUrl(): string | null {
    return siteUrl;
}

export function useSiteUrl(): string | null {
    return useSyncExternalStore(
        (fn) => {
            listeners.add(fn);
            return () => listeners.delete(fn);
        },
        getSiteUrl,
        getSiteUrl
    );
}
