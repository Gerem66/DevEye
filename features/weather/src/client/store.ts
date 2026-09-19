import { useEffect, useSyncExternalStore } from 'react';
import { isSocketOpen, onResourceChange, onSocketOpen } from 'deveye-sdk-client';
import type { WeatherLocation, WeatherReport } from '../contracts/domain';
import { api } from './api';
import { isKeyRefused } from './providers';

/**
 * Le magasin partagé de la tuile d'accueil et de la barre du haut : la ville
 * principale et son relevé, tenus à jour par une seule lecture. Il relit dès que
 * la socket s'ouvre, pour afficher la température à la connexion plutôt qu'au
 * prochain tour d'horloge.
 */
const REFRESH_MS = 10 * 60 * 1000;

interface WeatherStoreState {
    locations: WeatherLocation[];
    /** Le relevé de la ville principale. */
    report: WeatherReport | null;
    loading: boolean;
}

let state: WeatherStoreState = { locations: [], report: null, loading: true };
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let unsubState: (() => void) | null = null;
let unsubInvalidate: (() => void) | null = null;
let refCount = 0;
let inFlight = false;
// Une relecture demandée pendant qu'une autre tourne : on en refait exactement
// une à la fin, pour que celle qui suit l'ouverture de la socket ne soit jamais
// avalée par le garde `inFlight`.
let pending = false;

function emit(next: Partial<WeatherStoreState>): void {
    state = { ...state, ...next };
    for (const fn of listeners) fn();
}

/** La ville principale : celle qui est marquée, sinon la première. */
export function primaryLocation(locations: WeatherLocation[]): WeatherLocation | null {
    return locations.find((l) => l.isPrimary) ?? locations[0] ?? null;
}

export async function refreshWeather(): Promise<void> {
    if (inFlight) {
        pending = true;
        return;
    }
    inFlight = true;
    let primaryId: string | null = null;
    try {
        const list = await api.send('weather.list', {});
        // Les villes d'abord, avant le relevé, plus lent et qui peut échouer :
        // la tuile sait ainsi qu'une ville existe même quand son relevé manque.
        emit({ locations: list.locations });
        const primary = primaryLocation(list.locations);
        if (!primary) {
            emit({ report: null, loading: false });
            return;
        }
        primaryId = primary.id;
        const res = await api.send('weather.get', { id: primary.id });
        emit({ report: res.report, loading: false });
    } catch (e) {
        // Une clé refusée périme le relevé : le garder afficherait une température
        // que cette clé seule permettait d'obtenir. De même s'il est celui d'une
        // autre ville, la principale ayant changé. Tout autre échec garde le
        // dernier relevé, et socket fermée on reste en chargement : l'écouteur
        // d'ouverture réessaie.
        const foreign = primaryId !== null && state.report !== null && state.report.locationId !== primaryId;
        if (isKeyRefused(e) || foreign) emit({ report: null, loading: false });
        else if (isSocketOpen()) emit({ loading: false });
    } finally {
        inFlight = false;
        if (pending) {
            pending = false;
            void refreshWeather();
        }
    }
}

/** La fiche vient d'écrire : sa liste fait foi, et le relevé principal se relit. */
export function syncWeatherLocations(locations: WeatherLocation[]): void {
    emit({ locations });
    void refreshWeather();
}

function start(): void {
    refCount += 1;
    if (refCount > 1) return;
    void refreshWeather();
    timer = setInterval(() => void refreshWeather(), REFRESH_MS);
    unsubState = onSocketOpen(() => void refreshWeather());
    // Une ville ou une clé changée, par un autre membre ou depuis les réglages :
    // la barre comme la tuile suivent sans attendre le tour des dix minutes.
    unsubInvalidate = onResourceChange('weather.list', () => void refreshWeather());
}

function stop(): void {
    refCount -= 1;
    if (refCount > 0) return;
    refCount = 0;
    if (timer) {
        clearInterval(timer);
        timer = null;
    }
    pending = false;
    unsubState?.();
    unsubState = null;
    unsubInvalidate?.();
    unsubInvalidate = null;
}

function subscribe(cb: () => void): () => void {
    listeners.add(cb);
    return () => listeners.delete(cb);
}

function getSnapshot(): WeatherStoreState {
    return state;
}

export function useWeather(): WeatherStoreState & { primary: WeatherLocation | null } {
    const snap = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    useEffect(() => {
        start();
        return stop;
    }, []);
    return { ...snap, primary: primaryLocation(snap.locations) };
}
