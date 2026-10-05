import { useSyncExternalStore } from 'react';

import { daylightAt, positionFromTimezone, sunDay, type Position } from '@/sun';

/**
 * Thème clair ou sombre. Réglage propre à l'appareil, comme le mode de rendu :
 * `localStorage` seul, ni espace ni serveur. `public/color-scheme.js` relit la
 * même clé avant la première peinture, son format est donc un contrat avec lui.
 */
export type ColorSchemeMode = 'system' | 'auto' | 'dark' | 'light';
export type ColorScheme = 'dark' | 'light';

const KEY = 'deveye:color-scheme';
const MODES: readonly ColorSchemeMode[] = ['system', 'auto', 'dark', 'light'];
/** Une bascule manquée (veille, minuteur ralenti en arrière-plan) se rattrape au plus tard en ce délai. */
const RECHECK_MS = 10 * 60_000;

interface Stored {
    mode: ColorSchemeMode;
    /** Arrondie à 0,1° : une dizaine de kilomètres, assez pour le soleil. */
    position: Position | null;
    /** Lever et coucher du jour en minutes locales, pour le script de démarrage. */
    sun: { rise: number; set: number } | null;
}

export interface ColorSchemeState {
    mode: ColorSchemeMode;
    scheme: ColorScheme;
    /** Auto calcule sur la position du navigateur, sinon sur celle du fuseau. */
    located: boolean;
    locating: boolean;
    /** Les bornes du jour en cours, pour les dire à l'écran ; `null` hors Auto. */
    today: ReturnType<typeof sunDay> | null;
}

function read(): Stored {
    try {
        const raw = localStorage.getItem(KEY);
        if (!raw) return { mode: 'dark', position: null, sun: null };
        const p = JSON.parse(raw) as Partial<Stored>;
        const pos = p.position;
        return {
            mode: MODES.includes(p.mode as ColorSchemeMode) ? (p.mode as ColorSchemeMode) : 'dark',
            position:
                pos && Number.isFinite(pos.lat) && Number.isFinite(pos.lon) ? { lat: pos.lat, lon: pos.lon } : null,
            sun: null
        };
    } catch {
        return { mode: 'dark', position: null, sun: null };
    }
}

let stored = read();
let locating = false;
let timer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

const systemQuery =
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
        ? window.matchMedia('(prefers-color-scheme: light)')
        : null;

function sunPosition(): Position {
    return stored.position ?? positionFromTimezone();
}

function minutesOf(ms: number): number {
    const d = new Date(ms);
    return d.getHours() * 60 + d.getMinutes();
}

function compute(): ColorSchemeState {
    const base = { mode: stored.mode, located: stored.position !== null, locating, today: null };
    switch (stored.mode) {
        case 'light':
            return { ...base, scheme: 'light' };
        case 'dark':
            return { ...base, scheme: 'dark' };
        case 'system':
            return { ...base, scheme: systemQuery?.matches ? 'light' : 'dark' };
        case 'auto': {
            const now = Date.now();
            const pos = sunPosition();
            return { ...base, scheme: daylightAt(now, pos).light ? 'light' : 'dark', today: sunDay(now, pos) };
        }
    }
}

let snapshot = compute();

function persist(): void {
    let sun: Stored['sun'] = null;
    const today = snapshot.today;
    if (today) {
        if (!('polar' in today)) sun = { rise: minutesOf(today.rise), set: minutesOf(today.set) };
        else sun = today.polar === 'day' ? { rise: 0, set: 1440 } : { rise: 0, set: 0 };
    }
    stored = { ...stored, sun };
    try {
        localStorage.setItem(KEY, JSON.stringify(stored));
    } catch {
        // ignore (navigation privée, etc.)
    }
}

function apply(): void {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    if (snapshot.scheme === 'light') root.dataset.theme = 'light';
    else delete root.dataset.theme;
    document
        .querySelector('meta[name="theme-color"]')
        ?.setAttribute('content', getComputedStyle(root).getPropertyValue('--page-bg').trim() || '#000000');
}

/** En Auto, un réveil à la prochaine bascule du soleil, borné pour rattraper une veille. */
function schedule(): void {
    if (timer) clearTimeout(timer);
    timer = null;
    if (stored.mode !== 'auto' || typeof window === 'undefined') return;
    const { until } = daylightAt(Date.now(), sunPosition());
    const delay = until === null ? RECHECK_MS : Math.min(RECHECK_MS, Math.max(1000, until - Date.now() + 1000));
    timer = setTimeout(refresh, delay);
}

function refresh(): void {
    const prev = snapshot;
    snapshot = compute();
    if (prev.scheme !== snapshot.scheme) apply();
    schedule();
    if (
        prev.scheme !== snapshot.scheme ||
        prev.mode !== snapshot.mode ||
        prev.located !== snapshot.located ||
        prev.locating !== snapshot.locating ||
        JSON.stringify(prev.today) !== JSON.stringify(snapshot.today)
    ) {
        persist();
        for (const fn of listeners) fn();
    }
}

/** Posé avant le premier rendu React ; le script de démarrage l'a en principe déjà fait. */
apply();
schedule();

systemQuery?.addEventListener('change', refresh);
if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') refresh();
    });
}

/**
 * Demande la position au navigateur, une fois : le refus n'est pas une erreur,
 * Auto continue sur le fuseau et l'écran le dit.
 */
export function locate(): void {
    if (locating || typeof navigator === 'undefined' || !navigator.geolocation) return;
    locating = true;
    refresh();
    navigator.geolocation.getCurrentPosition(
        ({ coords }) => {
            locating = false;
            const round = (v: number) => Math.round(v * 10) / 10;
            stored = { ...stored, position: { lat: round(coords.latitude), lon: round(coords.longitude) } };
            refresh();
        },
        () => {
            locating = false;
            refresh();
        },
        { enableHighAccuracy: false, maximumAge: Infinity, timeout: 20_000 }
    );
}

export function setColorSchemeMode(mode: ColorSchemeMode): void {
    if (mode === stored.mode) return;
    stored = { ...stored, mode };
    refresh();
    if (mode === 'auto' && stored.position === null) locate();
}

export function getColorScheme(): ColorScheme {
    return snapshot.scheme;
}

export function subscribeColorScheme(cb: () => void): () => void {
    listeners.add(cb);
    return () => listeners.delete(cb);
}

function getSnapshot(): ColorSchemeState {
    return snapshot;
}

export function useColorSchemeState(): ColorSchemeState {
    return useSyncExternalStore(subscribeColorScheme, getSnapshot, getSnapshot);
}

export function useColorScheme(): ColorScheme {
    return useSyncExternalStore(subscribeColorScheme, getColorScheme, getColorScheme);
}
