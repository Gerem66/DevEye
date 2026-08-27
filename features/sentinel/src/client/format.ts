/**
 * Les formats propres à Sentinelle. `formatDuration` est la copie de celle du
 * Monitoring de l'app (`Features/Monitoring/utils.ts`), que la feature
 * importait avant son rapatriement : un module n'importe rien de l'app hors du
 * barrel, et douze lignes ne valent pas une entrée de SDK.
 */

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
