/** Formats d'affichage partagés entre features. */

/** Taille en octets, unités françaises (o / Ko / Mo / Go / To). */
export function formatBytesFr(bytes: number): string {
    if (bytes < 1024) return `${bytes} o`;
    if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} Ko`;
    if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} Mo`;
    if (bytes < 1024 ** 4) return `${(bytes / 1024 ** 3).toFixed(2)} Go`;
    return `${(bytes / 1024 ** 4).toFixed(2)} To`;
}
