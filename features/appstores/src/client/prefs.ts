import { useSyncExternalStore } from 'react';
import { appStoreSchema, appStoresRangeSchema, type AppStore, type AppStoresRange } from '../contracts/domain';

import { DEFAULT_RANGE } from './format';

/**
 * Les préférences d'affichage de Stores, locales au navigateur : une façon de
 * lire les chiffres, pas une propriété d'une app ni de l'espace.
 */
const KEY = 'deveye:appstores';

/** Ce que montre une courbe de téléchargements. `apps` n'a de sens que sur plusieurs apps. */
export type CurveView = 'stores' | 'total' | 'previous' | 'average' | 'apps';

/**
 * Où un choix vaut : les fiches des apps, toutes ensemble, ou la vue
 * d'ensemble avec son récapitulatif sur l'accueil. Changer l'un ne touche pas
 * l'autre.
 */
export type PrefsScope = 'sheet' | 'overview';

const VIEWS: Record<PrefsScope, readonly CurveView[]> = {
    sheet: ['stores', 'total', 'previous', 'average'],
    overview: ['stores', 'total', 'previous', 'average', 'apps']
};

export interface StoresPrefs {
    /** Ce que montrent les courbes de téléchargements. */
    curveView: CurveView;
    range: AppStoresRange;
    /** Le store affiché là où il y en a deux ; `all` pour les deux. */
    store: AppStore | 'all';
}

const DEFAULT: StoresPrefs = { curveView: 'stores', range: DEFAULT_RANGE, store: 'all' };

function parse(scope: PrefsScope, raw: Partial<StoresPrefs> | undefined): StoresPrefs {
    const store = appStoreSchema.safeParse(raw?.store);
    const range = appStoresRangeSchema.safeParse(raw?.range);
    return {
        curveView: VIEWS[scope].find((view) => view === raw?.curveView) ?? DEFAULT.curveView,
        range: range.success ? range.data : DEFAULT.range,
        store: store.success ? store.data : DEFAULT.store
    };
}

function load(): Record<PrefsScope, StoresPrefs> {
    try {
        const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Record<PrefsScope, Partial<StoresPrefs>>>;
        return { sheet: parse('sheet', raw.sheet), overview: parse('overview', raw.overview) };
    } catch {
        return { sheet: DEFAULT, overview: DEFAULT };
    }
}

let state = load();
const listeners = new Set<() => void>();

export function setStoresPrefs(scope: PrefsScope, patch: Partial<StoresPrefs>): void {
    state = { ...state, [scope]: { ...state[scope], ...patch } };
    try {
        localStorage.setItem(KEY, JSON.stringify(state));
    } catch {
        /* stockage indisponible (navigation privée, quota) : la valeur en mémoire suffit */
    }
    for (const fn of listeners) fn();
}

function subscribe(cb: () => void): () => void {
    listeners.add(cb);
    return () => listeners.delete(cb);
}

export function useStoresPrefs(scope: PrefsScope): StoresPrefs {
    const read = () => state[scope];
    return useSyncExternalStore(subscribe, read, read);
}
