import type { ColorScheme } from '@/stores/colorScheme';

/** Les jetons qu'un accent choisi dans Apparence remplace, en style inline sur la racine. */
export const ACCENT_VARS = [
    '--accent',
    '--accent-hover',
    '--accent-strong',
    '--accent-glow',
    '--accent-bg',
    '--on-accent'
] as const;

type Rgb = { r: number; g: number; b: number };

function hexToRgb(hex: string): Rgb {
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
function mix({ r, g, b }: Rgb, amount: number): Rgb {
    const target = amount >= 0 ? 255 : 0;
    const a = Math.abs(amount);
    const f = (c: number) => Math.round(c + (target - c) * a);
    return { r: f(r), g: f(g), b: f(b) };
}

function rgb({ r, g, b }: Rgb): string {
    return `rgb(${r}, ${g}, ${b})`;
}

function toHex({ r, g, b }: Rgb): string {
    return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

function toHsl({ r, g, b }: Rgb): { h: number; s: number; l: number } {
    const [rn, gn, bn] = [r / 255, g / 255, b / 255];
    const max = Math.max(rn, gn, bn);
    const min = Math.min(rn, gn, bn);
    const l = (max + min) / 2;
    if (max === min) return { h: 0, s: 0, l };
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    const h = max === rn ? (gn - bn) / d + (gn < bn ? 6 : 0) : max === gn ? (bn - rn) / d + 2 : (rn - gn) / d + 4;
    return { h: h / 6, s, l };
}

function fromHsl({ h, s, l }: { h: number; s: number; l: number }): Rgb {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    const channel = (t: number) => {
        const u = t < 0 ? t + 1 : t > 1 ? t - 1 : t;
        const v = u < 1 / 6 ? p + (q - p) * 6 * u : u < 1 / 2 ? q : u < 2 / 3 ? p + (q - p) * (2 / 3 - u) * 6 : p;
        return Math.round(v * 255);
    };
    return { r: channel(h + 1 / 3), g: channel(h), b: channel(h - 1 / 3) };
}

export function luminance(hex: string): number {
    const { r, g, b } = hexToRgb(hex);
    const lin = (c: number) => {
        const v = c / 255;
        return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** Luminance du verre clair composé sur le fond par défaut (≈ #f6f8fa). */
const LIGHT_GLASS = 0.93;

/**
 * L'accent tel que le thème le peint. En clair, sa luminosité baisse jusqu'à
 * tenir 4,5:1 sur le verre, parce qu'il sert de couleur de texte : les
 * préréglages, pensés pour le sombre, sont tous trop pâles pour un fond blanc.
 * Teinte et saturation restent, un mélange vers le noir les ternirait.
 */
export function accentFor(hex: string, scheme: ColorScheme): string {
    if (scheme === 'dark') return hex;
    const hsl = toHsl(hexToRgb(hex));
    for (let l = hsl.l; l > 0; l -= 0.01) {
        const c = toHex(fromHsl({ ...hsl, l }));
        if ((LIGHT_GLASS + 0.05) / (luminance(c) + 0.05) >= 4.5) return c;
    }
    return '#000000';
}

export function accentVars(hex: string, scheme: ColorScheme): Record<(typeof ACCENT_VARS)[number], string> {
    const accent = accentFor(hex, scheme);
    const base = hexToRgb(accent);
    const { r, g, b } = base;
    if (scheme === 'dark') {
        const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
        return {
            '--accent': accent,
            '--accent-hover': rgb(mix(base, 0.16)),
            '--accent-strong': rgb(mix(base, -0.14)),
            '--accent-glow': `rgba(${r}, ${g}, ${b}, 0.35)`,
            '--accent-bg': `rgba(${r}, ${g}, ${b}, 0.14)`,
            '--on-accent': lum > 0.6 ? '#05222a' : '#ffffff'
        };
    }
    // En clair, le survol fonce au lieu d'éclaircir, et le texte posé dessus est
    // blanc : l'accent tient déjà 4,5:1 face au verre, donc face au blanc.
    return {
        '--accent': accent,
        '--accent-hover': rgb(mix(base, -0.14)),
        '--accent-strong': rgb(mix(base, -0.26)),
        '--accent-glow': `rgba(${r}, ${g}, ${b}, 0.25)`,
        '--accent-bg': `rgba(${r}, ${g}, ${b}, 0.12)`,
        '--on-accent': '#ffffff'
    };
}
