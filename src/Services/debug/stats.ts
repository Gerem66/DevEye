export interface Summary {
    n: number;
    p50: number;
    p95: number;
    max: number;
    mean: number;
}

/** Centiles au rang le plus proche, arrondis au dixième de milliseconde ; `null` sans échantillon. */
export function summarize(samples: readonly number[]): Summary | null {
    if (samples.length === 0) return null;
    const sorted = [...samples].sort((a, b) => a - b);
    const rank = (p: number): number =>
        sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
    const round = (v: number): number => Math.round(v * 10) / 10;
    return {
        n: sorted.length,
        p50: round(rank(0.5)),
        p95: round(rank(0.95)),
        max: round(sorted[sorted.length - 1]),
        mean: round(sorted.reduce((sum, v) => sum + v, 0) / sorted.length)
    };
}
