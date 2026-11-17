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

const VIEWS: readonly CurveView[] = ['stores', 'total', 'previous', 'average', 'apps'];

/**
 * Un seul choix de chaque sorte pour toute la fonctionnalité : le changer
 * dans une fiche le change aussi dans les autres et dans la vue d'ensemble.
 */
export interface StoresPrefs {
    /** Ce que montrent les courbes de téléchargements. */
    curveView: CurveView;
    range: AppStoresRange;
    /** Le store affiché là où il y en a deux ; `all` pour les deux. */
    store: AppStore | 'all';
}

const DEFAULT: StoresPrefs = { curveView: 'stores', range: DEFAULT_RANGE, store: 'all' };

function load(): StoresPrefs {
    try {
        const raw = localStorage.getItem(KEY);
        if (!raw) return DEFAULT;
        const parsed = JSON.parse(raw) as Partial<StoresPrefs>;
        const store = appStoreSchema.safeParse(parsed.store);
        const range = appStoresRangeSchema.safeParse(parsed.range);
        return {
            curveView: VIEWS.find((view) => view === parsed.curveView) ?? DEFAULT.curveView,
            range: range.success ? range.data : DEFAULT.range,
            store: store.success ? store.data : DEFAULT.store
        };
    } catch {
        return DEFAULT;
    }
}

let state: StoresPrefs = load();
const listeners = new Set<() => void>();

export function setStoresPrefs(patch: Partial<StoresPrefs>): void {
    state = { ...state, ...patch };
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

function getSnapshot(): StoresPrefs {
    return state;
}

export function useStoresPrefs(): StoresPrefs {
    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** La vue retenue, ramenée à « par store » là où il n'y a qu'une app. */
export function useCurveView(severalApps: boolean): CurveView {
    const { curveView } = useStoresPrefs();
    return curveView === 'apps' && !severalApps ? 'stores' : curveView;
}
