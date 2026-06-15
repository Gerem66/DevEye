import { useSyncExternalStore } from 'react';

/**
 * Tiny localStorage-backed store for the optional dashboard wallpaper image.
 * Frontend-only display preference: when set, the dashboard switches from the
 * default cyan/teal gradient to a "photo + glass" background.
 */
const KEY = 'deveye:wallpaper';

function read(): string | null {
    try {
        const v = localStorage.getItem(KEY);
        return v && v.trim() ? v : null;
    } catch {
        return null;
    }
}

let current: string | null = read();
const listeners = new Set<() => void>();

export function getWallpaper(): string | null {
    return current;
}

export function setWallpaper(url: string | null): void {
    const next = url && url.trim() ? url.trim() : null;
    if (next === current) return;
    current = next;
    try {
        if (next) localStorage.setItem(KEY, next);
        else localStorage.removeItem(KEY);
    } catch {
        // ignore persistence failures (private mode, etc.)
    }
    for (const fn of listeners) fn();
}

function subscribe(cb: () => void): () => void {
    listeners.add(cb);
    return () => listeners.delete(cb);
}

/** React hook: current wallpaper image URL (or null) + setter. */
export function useWallpaper(): { image: string | null; setImage: (url: string | null) => void } {
    const image = useSyncExternalStore(subscribe, getWallpaper, () => null);
    return { image, setImage: setWallpaper };
}
