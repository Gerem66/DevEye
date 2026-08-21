/**
 * Formats partagés entre features. Né dans Monitoring, promu ici quand
 * CloudSync et Backup s'en sont servis aussi : un format d'affichage n'a pas
 * de feature propriétaire.
 */

/** Taille en octets, unités françaises (o / Ko / Mo / Go). */
export function formatBytesFr(bytes: number): string {
    if (bytes < 1024) return `${bytes} o`;
    if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} Ko`;
    if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} Mo`;
    return `${(bytes / 1024 ** 3).toFixed(2)} Go`;
}
