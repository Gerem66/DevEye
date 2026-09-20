import { useSyncExternalStore } from 'react';
import type { ThemeStateDTO } from '@deveye/types';
import { THEME_SLOT_COUNT, THEME_SLOT_IMAGE_MAX_LENGTH } from '@deveye/types';
import { ws } from '@/api/ws';
import { getActiveWorkspaceKey } from './workspace';

export { THEME_SLOT_COUNT };

/**
 * Theme personalization (accent color + dashboard background). Persisted in
 * localStorage for instant paint on load, and synced to the server.
 */
const KEY_PREFIX = 'deveye:theme';

/**
 * Le theme appartient a l'espace, donc une cle par espace. `null` avant qu'un
 * espace ne soit actif : on ne lit ni n'ecrit rien, ce qui empeche un compte
 * d'heriter de l'apparence du precedent.
 */
function storageKey(): string | null {
    const key = getActiveWorkspaceKey();
    return key === null ? null : `${KEY_PREFIX}:${key}`;
}

export interface ThemeState {
    /** Accent hex, or null for the default cyan. */
    accent: string | null;
    /** Background gradient preset key, or null for the accent-tinted default. */
    bgPreset: string | null;
    /** Active wallpaper image (data URL or raw URL) — takes over the gradient when set. */
    bgImage: string | null;
    /**
     * Saved background gallery: exactly THEME_SLOT_COUNT slots, each a data URL /
     * raw URL or null for empty. The active `bgImage` is normally one of these.
     */
    bgImages: (string | null)[];
    /** Darkening scrim strength over the image, 0–100 (0 = none). */
    bgDim: number;
    /** Blur intensity over the image, 0–100 (0 = none). */
    bgBlur: number;
}

export const DEFAULT_DIM = 45;
export const DEFAULT_BLUR = 0;
const emptySlots = (): (string | null)[] => Array<string | null>(THEME_SLOT_COUNT).fill(null);
const DEFAULT: ThemeState = {
    accent: null,
    bgPreset: null,
    bgImage: null,
    bgImages: emptySlots(),
    bgDim: DEFAULT_DIM,
    bgBlur: DEFAULT_BLUR
};

/** Coerce any persisted/server value into a fixed-length array of THEME_SLOT_COUNT slots. */
function normalizeSlots(input: unknown): (string | null)[] {
    const arr = Array.isArray(input) ? input : [];
    const out = emptySlots();
    for (let i = 0; i < THEME_SLOT_COUNT; i++) {
        const v = arr[i];
        out[i] = typeof v === 'string' && v ? v : null;
    }
    return out;
}

/**
 * Put the active background in a gallery slot when there is room; with every slot
 * taken it stays "overflow", unsaved.
 */
function ensureActiveSlotted(s: ThemeState): ThemeState {
    if (!s.bgImage || s.bgImages.includes(s.bgImage)) return s;
    // An oversized image would exceed the slot cap and fail server validation on
    // sync: it stays as the active "overflow" background instead.
    if (s.bgImage.length > THEME_SLOT_IMAGE_MAX_LENGTH) return s;
    const free = s.bgImages.indexOf(null);
    if (free === -1) return s;
    const bgImages = s.bgImages.slice();
    bgImages[free] = s.bgImage;
    return { ...s, bgImages };
}

export const ACCENT_PRESETS: { key: string; label: string; hex: string }[] = [
    { key: 'cyan', label: 'Cyan', hex: '#22d3ee' },
    { key: 'teal', label: 'Teal', hex: '#2dd4bf' },
    { key: 'blue', label: 'Bleu', hex: '#3b82f6' },
    { key: 'indigo', label: 'Indigo', hex: '#818cf8' },
    { key: 'violet', label: 'Violet', hex: '#a78bfa' },
    { key: 'emerald', label: 'Émeraude', hex: '#34d399' },
    { key: 'amber', label: 'Ambre', hex: '#fbbf24' },
    { key: 'rose', label: 'Rose', hex: '#fb7185' }
];

export const BG_PRESETS: { key: string; label: string; css: string | null }[] = [
    { key: 'auto', label: 'Accent', css: null },
    { key: 'midnight', label: 'Nuit', css: 'linear-gradient(160deg, #05070d 0%, #0a0e16 100%)' },
    {
        key: 'ocean',
        label: 'Océan',
        css: 'radial-gradient(1000px circle at 18% -10%, rgba(20, 130, 170, 0.26), transparent 55%), linear-gradient(160deg, #04070e 0%, #07131f 60%, #050b14 100%)'
    },
    {
        key: 'plum',
        label: 'Prune',
        css: 'radial-gradient(900px circle at 85% -10%, rgba(150, 100, 240, 0.2), transparent 55%), linear-gradient(160deg, #07060f 0%, #0d0a1a 60%, #08060f 100%)'
    }
];

function read(): ThemeState {
    try {
        const key = storageKey();
        if (key === null) return DEFAULT;
        const raw = localStorage.getItem(key);
        if (!raw) return DEFAULT;
        const p = JSON.parse(raw) as Partial<ThemeState>;
        return ensureActiveSlotted({
            accent: typeof p.accent === 'string' ? p.accent : null,
            bgPreset: typeof p.bgPreset === 'string' ? p.bgPreset : null,
            bgImage: typeof p.bgImage === 'string' ? p.bgImage : null,
            bgImages: normalizeSlots(p.bgImages),
            bgDim: typeof p.bgDim === 'number' ? Math.min(100, Math.max(0, p.bgDim)) : DEFAULT_DIM,
            bgBlur: typeof p.bgBlur === 'number' ? Math.min(100, Math.max(0, p.bgBlur)) : DEFAULT_BLUR
        });
    } catch {
        return DEFAULT;
    }
}

let state: ThemeState = read();
const listeners = new Set<() => void>();

function hexToRgb(hex: string): { r: number; g: number; b: number } {
    const h = hex.replace('#', '');
    const full =
        h.length === 3
            ? h
                  .split('')
                  .map((c) => c + c)
                  .join('')
            : h;
    const n = parseInt(full, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/** Mix toward white (amount > 0) or black (amount < 0). */
function shade(hex: string, amount: number): string {
    const { r, g, b } = hexToRgb(hex);
    const target = amount >= 0 ? 255 : 0;
    const a = Math.abs(amount);
    const f = (c: number) => Math.round(c + (target - c) * a);
    return `rgb(${f(r)}, ${f(g)}, ${f(b)})`;
}

function applyTheme(s: ThemeState): void {
    if (typeof document === 'undefined') return;
    const root = document.documentElement.style;

    if (s.accent) {
        const { r, g, b } = hexToRgb(s.accent);
        root.setProperty('--accent', s.accent);
        root.setProperty('--accent-hover', shade(s.accent, 0.16));
        root.setProperty('--accent-strong', shade(s.accent, -0.14));
        root.setProperty('--accent-glow', `rgba(${r}, ${g}, ${b}, 0.35)`);
        root.setProperty('--accent-bg', `rgba(${r}, ${g}, ${b}, 0.14)`);
        const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
        root.setProperty('--on-accent', lum > 0.6 ? '#05222a' : '#ffffff');
    } else {
        for (const v of [
            '--accent',
            '--accent-hover',
            '--accent-strong',
            '--accent-glow',
            '--accent-bg',
            '--on-accent'
        ]) {
            root.removeProperty(v);
        }
    }

    const preset = BG_PRESETS.find((p) => p.key === s.bgPreset);
    if (preset?.css) root.setProperty('--wallpaper-bg', preset.css);
    else root.removeProperty('--wallpaper-bg');

    // Scrim alpha climbs with the slider (0 → fully visible, 100 → ~0.88 dark).
    const dim = Math.min(100, Math.max(0, s.bgDim));
    root.setProperty('--wallpaper-scrim', String(((dim / 100) * 0.88).toFixed(3)));
    // Blur radius (px) scales independently with its own slider (0–100 → 0–20px).
    const blur = Math.min(100, Math.max(0, s.bgBlur));
    root.setProperty('--wallpaper-blur', blur > 0 ? `${((blur / 100) * 20).toFixed(1)}px` : '0px');
}

applyTheme(state);

function persist(): void {
    try {
        const key = storageKey();
        if (key === null) return;
        localStorage.setItem(key, JSON.stringify(state));
    } catch {
        // ignore (private mode, etc.)
    }
}

// Debounced server sync: coalesce rapid changes (slider drag, etc.) into one WS call.
let syncTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleSyncToServer(): void {
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = setTimeout(() => {
        syncTimer = null;
        if (ws.state !== 'open') return;
        // `state` est lu au déclenchement, pas à la programmation : l'apparence d'un
        // autre membre peut arriver pendant l'attente, et un instantané capturé à
        // l'appel la réécrirait.
        void ws.send('user.setTheme', state).catch(() => {});
    }, 1000);
}

export function getTheme(): ThemeState {
    return state;
}

export function setTheme(patch: Partial<ThemeState>): void {
    state = { ...state, ...patch };
    persist();
    applyTheme(state);
    scheduleSyncToServer();
    for (const fn of listeners) fn();
}

/**
 * Apply `value` as the active background and remember it in the first free
 * gallery slot; one that already occupies a slot is merely re-activated. With
 * every slot taken it still becomes active but is lost on the next change, which
 * the returned flag lets the UI warn about.
 */
export function saveBackground(value: string): { saved: boolean } {
    const bgImages = state.bgImages.slice();
    let saved = true;
    if (!bgImages.includes(value)) {
        const free = bgImages.indexOf(null);
        if (free !== -1) bgImages[free] = value;
        else saved = false;
    }
    setTheme({ bgImage: value, bgImages });
    return { saved };
}

/** Empty a specific gallery slot, freeing it for the next saved background. */
export function clearBackgroundSlot(index: number): void {
    if (index < 0 || index >= state.bgImages.length || state.bgImages[index] === null) return;
    const bgImages = state.bgImages.slice();
    bgImages[index] = null;
    setTheme({ bgImages });
}

/** The server state wins over localStorage so cross-device settings propagate. */
export function syncThemeFromServer(serverTheme: ThemeStateDTO | null): void {
    // Aucun theme enregistre pour cet espace : le defaut, pas celui de l'espace precedent.
    if (!serverTheme) {
        resetTheme();
        return;
    }
    state = ensureActiveSlotted({
        accent: serverTheme.accent,
        bgPreset: serverTheme.bgPreset,
        bgImage: serverTheme.bgImage,
        bgImages: normalizeSlots(serverTheme.bgImages),
        bgDim: serverTheme.bgDim,
        bgBlur: serverTheme.bgBlur
    });
    persist();
    applyTheme(state);
    for (const fn of listeners) fn();
}

/**
 * Revient au theme par defaut sans rien ecrire. Ne purge pas les cles des autres
 * espaces, qui restent valables au prochain passage.
 */
export function resetTheme(): void {
    state = DEFAULT;
    applyTheme(state);
    for (const fn of listeners) fn();
}

function subscribe(cb: () => void): () => void {
    listeners.add(cb);
    return () => listeners.delete(cb);
}

export function useTheme(): ThemeState {
    return useSyncExternalStore(subscribe, getTheme, getTheme);
}
