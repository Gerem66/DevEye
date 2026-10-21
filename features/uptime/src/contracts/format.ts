/** Les formats partagés par l'écran et la page de statut publique : une seule règle pour les deux. */

/** Les étiquettes des lignes d'un écart, telles que la sonde les écrit et que l'écran les relit. */
export const DRIFT_LABELS = { changed: 'Modifié :', added: 'Ajouté :', removed: 'Retiré :' } as const;

/**
 * Une ligne d'écart décomposée : son étiquette, son chemin, et si le site le
 * sert encore (modifié ou ajouté). `null` pour une ligne sans chemin (la
 * politique de contenu, « … et N autres »).
 */
export function parseDriftLine(line: string): { label: string; path: string; served: boolean } | null {
    for (const [kind, label] of Object.entries(DRIFT_LABELS)) {
        if (line.startsWith(`${label} `)) {
            return { label, path: line.slice(label.length + 1), served: kind !== 'removed' };
        }
    }
    return null;
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

/** "2 h 5 min" : a span of seconds, coarsest useful unit first. */
export function formatDuration(seconds: number): string {
    if (seconds < 60) return `${seconds} s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes} min`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} h ${minutes % 60} min`;
    return `${Math.floor(hours / 24)} j ${hours % 24} h`;
}

/** « 30 s », « 5 min », « 6 h », « 1 j » : une cadence, dans son unité ronde. */
export function formatInterval(seconds: number): string {
    if (seconds < 60) return `${seconds} s`;
    if (seconds % 86400 === 0) return `${seconds / 86400} j`;
    if (seconds % 3600 === 0) return `${seconds / 3600} h`;
    if (seconds % 60 === 0) return `${seconds / 60} min`;
    return `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}

const EVERY: Readonly<Record<number, string>> = { 60: 'chaque minute', 3600: 'chaque heure', 86400: 'chaque jour' };

/** « chaque minute », « toutes les 5 min ». */
export function formatEvery(seconds: number): string {
    return EVERY[seconds] ?? `toutes les ${formatInterval(seconds)}`;
}
