import { useSyncExternalStore } from 'react';

/**
 * Frontend-only theme personalization (accent color + dashboard background).
 * Persisted in localStorage and applied as CSS custom properties on :root, so
 * the whole token system follows along. Kept deliberately sober.
 */
const KEY = 'deveye:theme';

export interface ThemeState {
    /** Accent hex, or null for the default cyan. */
    accent: string | null;
    /** Background gradient preset key, or null for the accent-tinted default. */
    bgPreset: string | null;
    /** Optional wallpaper image URL (takes over the gradient when set). */
    bgImage: string | null;
    /** Darkening scrim strength over the image, 0–100 (0 = none). */
    bgDim: number;
    /** Whether to blur the image (intensity follows `bgDim`). */
    bgBlur: boolean;
}

export const DEFAULT_DIM = 45;
const DEFAULT: ThemeState = { accent: null, bgPreset: null, bgImage: null, bgDim: DEFAULT_DIM, bgBlur: false };

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
        const raw = localStorage.getItem(KEY);
        if (!raw) return DEFAULT;
        const p = JSON.parse(raw) as Partial<ThemeState>;
        return {
            accent: typeof p.accent === 'string' ? p.accent : null,
            bgPreset: typeof p.bgPreset === 'string' ? p.bgPreset : null,
            bgImage: typeof p.bgImage === 'string' ? p.bgImage : null,
            bgDim: typeof p.bgDim === 'number' ? Math.min(100, Math.max(0, p.bgDim)) : DEFAULT_DIM,
            bgBlur: typeof p.bgBlur === 'boolean' ? p.bgBlur : false
        };
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
    // Blur radius (px) also scales with the slider, but only when enabled.
    root.setProperty('--wallpaper-blur', s.bgBlur ? `${((dim / 100) * 16).toFixed(1)}px` : '0px');
}

// Apply persisted theme as soon as the module loads.
applyTheme(state);

function persist(): void {
    try {
        localStorage.setItem(KEY, JSON.stringify(state));
    } catch {
        // ignore (private mode, etc.)
    }
}

export function getTheme(): ThemeState {
    return state;
}

export function setTheme(patch: Partial<ThemeState>): void {
    state = { ...state, ...patch };
    persist();
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
