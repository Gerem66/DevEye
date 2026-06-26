import { useEffect, useSyncExternalStore } from 'react';
import { ws } from '@/api/ws';
import type { WeatherLocation, WeatherReport } from 'deveye-types';

/**
 * Shared weather store. Resolves the user's primary city and keeps its live
 * report fresh so the topbar status and the home widget stay in sync without
 * each re-fetching independently.
 *
 * Crucially, it reloads as soon as the WebSocket becomes `open` — so the widget
 * shows the temperature immediately on connect instead of being stuck on
 * "Aucune météo configurée" until the next 10-minute poll (the old behaviour,
 * which failed silently when the socket wasn't ready yet at mount time).
 */
const REFRESH_MS = 10 * 60 * 1000;

interface WeatherStoreState {
    /** All configured locations, primary-first then by position. */
    locations: WeatherLocation[];
    /** Live report for the primary location. */
    report: WeatherReport | null;
    loading: boolean;
}

let state: WeatherStoreState = { locations: [], report: null, loading: true };
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let unsubState: (() => void) | null = null;
let refCount = 0;
let inFlight = false;
// A refresh requested while one was already running: we run exactly one more
// pass when the current one settles, so a "socket just opened" retry arriving
// mid-flight is never swallowed by the `inFlight` guard.
let pending = false;

function emit(next: Partial<WeatherStoreState>): void {
    state = { ...state, ...next };
    for (const fn of listeners) fn();
}

/** The primary city: the one flagged primary, else the first by position. */
export function primaryLocation(locations: WeatherLocation[]): WeatherLocation | null {
    return locations.find((l) => l.isPrimary) ?? locations[0] ?? null;
}

export async function refreshWeather(): Promise<void> {
    // Coalesce concurrent calls: note that another refresh was asked for and run
    // it once the in-flight one settles (see the `pending` handling below).
    if (inFlight) {
        pending = true;
        return;
    }
    inFlight = true;
    try {
        const list = await ws.send('weather.list', {});
        // Surface the configured cities as soon as we have them, *before* the
        // slower, provider-dependent report fetch. This is what stops a failed
        // or slow report from masquerading as "Aucune météo configurée": the
        // primary city stays known even when its report isn't here yet.
        emit({ locations: list.locations });
        const primary = primaryLocation(list.locations);
        if (!primary) {
            emit({ report: null, loading: false });
            return;
        }
        const res = await ws.send('weather.get', { id: primary.id });
        emit({ report: res.report, loading: false });
    } catch {
        // If the socket isn't open yet, stay in the loading state — the state
        // listener retries the moment it connects (avoids a misleading "no
        // weather" flash). Only give up the spinner on a real, connected error;
        // locations surfaced above survive, so a failed report never reads as
        // "Aucune météo configurée".
        if (ws.state === 'open') emit({ loading: false });
    } finally {
        inFlight = false;
        if (pending) {
            pending = false;
            void refreshWeather();
        }
    }
}

/**
 * Push an authoritative locations list (e.g. after the full Weather view adds,
 * removes, reorders or re-primaries cities) and refresh the primary report.
 */
export function syncWeatherLocations(locations: WeatherLocation[]): void {
    emit({ locations });
    void refreshWeather();
}

function start(): void {
    refCount += 1;
    if (refCount > 1) return;
    void refreshWeather();
    timer = setInterval(() => void refreshWeather(), REFRESH_MS);
    // Reload as soon as the socket (re)connects.
    unsubState = ws.onStateChange((s) => {
        if (s === 'open') void refreshWeather();
    });
    if (ws.state === 'open') void refreshWeather();
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
