import { useEffect, useState } from 'react';
import { errorNote, invalidate, type ErrorNoteInput } from 'deveye-sdk-client';
import type { AppStore, AppStoresApp, AppStoresAppInput, AppStoresListing } from '../contracts/domain';

import { api } from './api';

export const listingOf = (app: AppStoresApp, store: AppStore): AppStoresListing | null =>
    app.listings.find((listing) => listing.store === store) ?? null;

/** Tout ce que montre une app relue : ses écrans se relisent avec elle. */
export const changedApp = () =>
    invalidate(
        'appstores.list',
        'appstores.count',
        'appstores.detail',
        'appstores.stats',
        'appstores.reviews',
        'appstores.revenue'
    );

/** Ce qu'`appstores.update` attend : l'app telle qu'elle est, sauf ce que l'onglet change. */
export function updateOf(app: AppStoresApp, change: Partial<AppStoresAppInput>): AppStoresAppInput & { appId: number } {
    const kept = (store: AppStore) => {
        const listing = listingOf(app, store);
        return listing ? { sourceId: listing.sourceId, externalId: listing.externalId } : null;
    };
    return {
        appId: app.id,
        name: app.name,
        ratingCountry: app.ratingCountry,
        apple: kept('apple'),
        google: kept('google'),
        ...change
    };
}

/** L'app d'un onglet de ses réglages, lue à son ouverture. */
export function useSettingsApp(appId: number | null, onLoaded: (app: AppStoresApp) => void) {
    const [app, setApp] = useState<AppStoresApp | null>(null);
    const [loadError, setLoadError] = useState<ErrorNoteInput | null>(null);

    useEffect(() => {
        if (appId === null) return;
        let alive = true;
        api.send('appstores.get', { appId })
            .then((res) => {
                if (!alive) return;
                setApp(res.app);
                onLoaded(res.app);
            })
            .catch((e: unknown) => {
                if (alive) setLoadError(errorNote(e, 'L’app n’a pas pu être lue.'));
            });
        return () => {
            alive = false;
        };
        // `onLoaded` ne pose que des états : seule l'app change ce qui se lit.
    }, [appId]);

    return { app, setApp, loadError };
}
