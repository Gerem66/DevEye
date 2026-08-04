import type { MetricSeriesPoint } from 'deveye-types';

/**
 * Shared formatting + activity helpers for the monitoring views. Kept here so
 * both the full panel ({@link ./MonitoringPanel}) and the compact device tile
 * ({@link ./DeviceWidget}) derive the same numbers and labels (DRY).
 */

export function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
    return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

export function formatRate(bytesPerSec: number): string {
    return `${formatBytes(Math.max(0, Math.round(bytesPerSec)))}/s`;
}

/** Byte size with French units (o / Ko / Mo / Go) — used for DB footprint. */
export function formatBytesFr(bytes: number): string {
    if (bytes < 1024) return `${bytes} o`;
    if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} Ko`;
    if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} Mo`;
    return `${(bytes / 1024 ** 3).toFixed(2)} Go`;
}

export function formatUptime(seconds: number): string {
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    if (d > 0) return `${d}j ${h}h`;
    if (h > 0) return `${h}h ${m}min`;
    return `${m}min`;
}

/** Compact span label (e.g. "24 h", "3 h 30", "12 min") for the graph window. */
export function formatDuration(ms: number): string {
    const totalMin = Math.max(0, Math.round(ms / 60000));
    if (totalMin < 60) return `${totalMin} min`;
    const totalH = Math.floor(totalMin / 60);
    const remMin = totalMin % 60;
    if (totalH < 24) return remMin > 0 ? `${totalH} h ${remMin.toString().padStart(2, '0')}` : `${totalH} h`;
    const days = Math.floor(totalH / 24);
    const remH = totalH % 24;
    return remH > 0 ? `${days} j ${remH} h` : `${days} j`;
}

/** Round step (ms) chosen from a "nice" ladder so a span gets ~`target` grid lines. */
const NICE_STEPS_MS = [
    60_000, // 1 min
    2 * 60_000,
    5 * 60_000,
    10 * 60_000,
    15 * 60_000,
    30 * 60_000,
    60 * 60_000, // 1 h
    2 * 3_600_000,
    3 * 3_600_000,
    6 * 3_600_000,
    12 * 3_600_000,
    24 * 3_600_000 // 1 day
];

/**
 * Vertical grid tick timestamps for a [tMin, tMax] window: a handful of round
 * local-clock instants (aligned to the chosen step), so the graph shows the
 * order of magnitude in hours without labelling every point. Aligns to the local
 * day to keep hour labels on the clock (handles the local UTC offset).
 */
export function niceTimeTicks(tMin: number, tMax: number, target = 5): number[] {
    const span = tMax - tMin;
    if (span <= 0) return [];
    const rough = span / target;
    const step = NICE_STEPS_MS.find((s) => s >= rough) ?? NICE_STEPS_MS[NICE_STEPS_MS.length - 1];
    // Align to local midnight so ticks land on round clock times, not on tMin.
    const offsetMs = new Date(tMin).getTimezoneOffset() * 60000;
    const first = Math.ceil((tMin - offsetMs) / step) * step + offsetMs;
    const ticks: number[] = [];
    for (let t = first; t <= tMax && ticks.length < 24; t += step) {
        if (t >= tMin) ticks.push(t);
    }
    return ticks;
}

export function formatAgo(ts: number): string {
    const mins = Math.floor((Date.now() - ts) / 60000);
    if (mins < 1) return "à l'instant";
    if (mins < 60) return `${mins} min`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours} h`;
    return `${Math.floor(hours / 24)} j`;
}

export function pct(used: number, total: number): number {
    return total > 0 ? (used / total) * 100 : 0;
}

/** Coarse activity level derived from a snapshot. */
export type Activity = 'idle' | 'normal' | 'intensive';

export function activityLevel(s: MetricSeriesPoint | null, cores: number): Activity {
    if (!s) return 'idle';
    const ram = pct(s.memUsedBytes, s.memTotalBytes);
    const gpu = s.gpuPercent ?? 0;
    const loadRatio = s.loadAvg1 != null && cores > 0 ? s.loadAvg1 / cores : 0;
    if (s.cpuPercent >= 80 || gpu >= 80 || loadRatio >= 0.9 || ram >= 90) return 'intensive';
    if (s.cpuPercent < 10 && gpu < 12 && loadRatio < 0.3 && ram < 75) return 'idle';
    return 'normal';
}

export const ACTIVITY_META: Record<Activity, { label: string; cls: string }> = {
    idle: { label: 'Au repos', cls: 'actIdle' },
    normal: { label: 'Usage normal', cls: 'actNormal' },
    intensive: { label: 'Usage intensif', cls: 'actIntense' }
};
