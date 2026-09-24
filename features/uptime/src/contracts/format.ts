/** Les formats partagés par l'écran et la page de statut publique : une seule règle pour les deux. */

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

/** "2 h 5 min" : a span of seconds, coarsest useful unit first. */
export function formatDuration(seconds: number): string {
    if (seconds < 60) return `${seconds} s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes} min`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} h ${minutes % 60} min`;
    return `${Math.floor(hours / 24)} j ${hours % 24} h`;
}
