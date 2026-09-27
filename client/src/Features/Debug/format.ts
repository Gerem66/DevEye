/** Une durée lisible : « 182 ms », « 1,4 s », « 2 min 05 ». */
export function formatMs(ms: number | null): string {
    if (ms === null) return '–';
    if (ms < 10) return `${ms.toLocaleString('fr-FR', { maximumFractionDigits: 1 })} ms`;
    if (ms < 1000) return `${Math.round(ms)} ms`;
    if (ms < 60_000) return `${(ms / 1000).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} s`;
    const minutes = Math.floor(ms / 60_000);
    const seconds = Math.round((ms % 60_000) / 1000);
    return `${minutes} min ${String(seconds).padStart(2, '0')}`;
}

/** Un écart relatif signé : « +12 % », « −8 % ». `null` sans référence. */
export function formatDelta(pct: number | null): string {
    if (pct === null || !Number.isFinite(pct)) return '–';
    const rounded = Math.round(pct);
    if (rounded === 0) return '=';
    return `${rounded > 0 ? '+' : '−'}${Math.abs(rounded)} %`;
}

export function relativeDelta(value: number | null, reference: number | null): number | null {
    if (value === null || reference === null || reference <= 0) return null;
    return ((value - reference) / reference) * 100;
}

/** « 27 sept., 18:42 ». */
export function formatMoment(ms: number): string {
    return new Date(ms).toLocaleString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export function median(values: readonly number[]): number | null {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}
