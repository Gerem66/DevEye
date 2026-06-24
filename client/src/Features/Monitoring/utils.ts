import type { MetricSnapshot } from 'deveye-types';

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

export function activityLevel(s: MetricSnapshot | null, cores: number): Activity {
    if (!s) return 'idle';
    const ram = pct(s.memUsedBytes, s.memTotalBytes);
    const gpu = s.gpuPercent ?? 0;
    const loadRatio = s.loadAvg1 != null && cores > 0 ? s.loadAvg1 / cores : 0;
    if (s.cpuPercent >= 60 || gpu >= 60 || loadRatio >= 0.9 || ram >= 88) return 'intensive';
    if (s.cpuPercent < 10 && gpu < 12 && loadRatio < 0.35 && ram < 60) return 'idle';
    return 'normal';
}

export const ACTIVITY_META: Record<Activity, { label: string; cls: string }> = {
    idle: { label: 'Au repos', cls: 'actIdle' },
    normal: { label: 'Usage normal', cls: 'actNormal' },
    intensive: { label: 'Usage intensif', cls: 'actIntense' }
};
