import type { UptimePoint, UptimeRange } from '../contracts/domain';

const DAY = 86400;

/** The ranges offered by the detail view's selector, in order. */
export const RANGES: { value: UptimeRange; label: string }[] = [
    { value: '24h', label: '24 h' },
    { value: '7d', label: '7 j' },
    { value: '30d', label: '30 j' },
    { value: '90d', label: '90 j' },
    { value: '1y', label: '1 an' },
    { value: 'all', label: 'Tout' }
];

/** Seconds a range covers; `null` for "Tout", which the data itself bounds. */
const RANGE_SECONDS: Record<UptimeRange, number | null> = {
    '24h': DAY,
    '7d': 7 * DAY,
    '30d': 30 * DAY,
    '90d': 90 * DAY,
    '1y': 365 * DAY,
    all: null
};

/**
 * The time window a range actually spans : the shared x-axis of the status strip
 * and the latency curve.
 *
 * It is the **selected duration**, not the extent of the data: a service added
 * ten minutes ago must show 24 h of "no data" behind its first samples, not
 * stretch ten minutes across the whole width. "Tout" is the exception, having no
 * duration of its own, so the oldest sample opens it.
 */
export function rangeWindow(range: UptimeRange, points: UptimePoint[]): { from: number; to: number } {
    const to = Math.floor(Date.now() / 1000);
    const span = RANGE_SECONDS[range];
    if (span !== null) return { from: to - span, to };
    return { from: points[0]?.at ?? to - DAY, to };
}

/** "99,95 %" : a ratio in 0→1, or "—" when there is no data yet. */
export function formatRatio(ratio: number | null): string {
    if (ratio === null) return '—';
    // Truncated, never rounded: 99.999 % must not read as a flawless "100 %".
    // Two decimals below that, because "99,9 %" would hide 0.05 % of downtime.
    const percent = Math.floor(ratio * 10000) / 100;
    const digits = percent === 100 ? 0 : 2;
    return `${percent.toLocaleString('fr-FR', { minimumFractionDigits: digits, maximumFractionDigits: digits })} %`;
}

export function formatMs(ms: number | null): string {
    if (ms === null) return '—';
    return ms >= 1000 ? `${(ms / 1000).toLocaleString('fr-FR', { maximumFractionDigits: 2 })} s` : `${ms} ms`;
}

/** "31/07/2026 14:32:05". */
export function formatMoment(epochSeconds: number): string {
    return new Date(epochSeconds * 1000).toLocaleString('fr-FR', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
    });
}

/** "2 h 5 min" : a span of seconds, coarsest useful unit first. */
export function formatDuration(seconds: number): string {
    if (seconds < 60) return `${seconds} s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes} min`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} h ${minutes % 60} min`;
    return `${Math.floor(hours / 24)} j ${hours % 24} h`;
}

/** "il y a 3 min" : how long ago a check happened. */
export function formatAgo(epochSeconds: number | null): string {
    if (epochSeconds === null) return 'jamais testé';
    const delta = Math.max(0, Math.floor(Date.now() / 1000) - epochSeconds);
    return delta < 10 ? "à l'instant" : `il y a ${formatDuration(delta)}`;
}

/** Axis label matching a bucket size: a time for raw/hour points, a date for days. */
export function formatBucket(epochSeconds: number, daily: boolean): string {
    const date = new Date(epochSeconds * 1000);
    return daily
        ? date.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: '2-digit' })
        : date.toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

/** Les quatre réglages fins d'un service : le panneau Général les édite, un service neuf reçoit leurs défauts. */
export interface ServiceTuning {
    intervalSeconds: number;
    timeoutSeconds: number;
    failureThreshold: number;
    retentionDays: number | null;
}

/** Un champ numérique ramené dans ses bornes ; vide ou illisible vaut le minimum. */
export function clamp(raw: string, min: number, max: number): number {
    return Math.min(max, Math.max(min, Number(raw) || min));
}
