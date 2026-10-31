import type { DebugLoadSample } from '@deveye/types';

/** Les premiers seaux avec des utilisateurs, peu nombreux encore : la référence. */
const BASELINE_BUCKETS = 3;
/** Dégradé : le p95 au double de la référence, et 100 ms de plus au moins (une référence de 3 ms doublée n'est rien). */
const DEGRADED_FACTOR = 2;
const DEGRADED_MARGIN_MS = 100;
/** Un seuil se lit sur deux seaux de suite : un seul pic n'est pas un régime. */
const STREAK = 2;

/** Le garde-fou : au-delà, la montée s'arrête, le serveur ne suit plus. */
const SATURATION: { label: string; hit(s: DebugLoadSample): boolean }[] = [
    { label: 'temps de réponse p95 au-delà de 3 s', hit: (s) => (s.p95 ?? 0) > 3000 },
    { label: 'plus de 5 % d’erreurs', hit: (s) => s.errors > 0.05 * Math.max(1, s.commands) },
    { label: 'boucle d’événements en retard de plus d’1 s', hit: (s) => s.loopP99 > 1000 }
];

const median = (values: readonly number[]): number => {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
};

export interface LoadVerdict {
    baselineP95: number | null;
    degradedAt: { t: number; users: number } | null;
}

/** La référence et le début de la dégradation, relus à chaque seau. */
export function analyze(samples: readonly DebugLoadSample[]): LoadVerdict {
    const measured = samples.filter((s) => s.users > 0 && s.p95 !== null);
    if (measured.length < BASELINE_BUCKETS) return { baselineP95: null, degradedAt: null };
    const baselineP95 = median(measured.slice(0, BASELINE_BUCKETS).map((s) => s.p95 as number));
    const limit = Math.max(baselineP95 * DEGRADED_FACTOR, baselineP95 + DEGRADED_MARGIN_MS);
    const degraded = (s: DebugLoadSample): boolean => (s.p95 ?? 0) > limit;
    const at = measured.findIndex(
        (_, i) => i + STREAK <= measured.length && measured.slice(i, i + STREAK).every(degraded)
    );
    return {
        baselineP95: Math.round(baselineP95 * 10) / 10,
        degradedAt: at < 0 ? null : { t: measured[at].t, users: measured[at].users }
    };
}

/** Pourquoi arrêter la montée, d'après les derniers seaux ; `null` tant que le serveur suit. */
export function saturation(samples: readonly DebugLoadSample[]): string | null {
    const last = samples.slice(-STREAK);
    if (last.length < STREAK) return null;
    return SATURATION.find((rule) => last.every(rule.hit))?.label ?? null;
}
