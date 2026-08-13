import type { DeployStatus } from 'deveye-types';

/** Le vocabulaire d'état, un seul jeu pour toute la feature. */
export const STATUS_LABELS: Record<DeployStatus, string> = {
    queued: 'En attente',
    running: 'En cours',
    success: 'Réussi',
    failed: 'Échoué'
};

/**
 * La teinte d'un état, et le parti pris qu'elle porte.
 *
 * « En attente » et « En cours » sont neutres, pas alarmants : ce sont les états
 * normaux d'un déploiement qui vient de partir. Les peindre en couleur ferait
 * passer un travail en cours pour un incident — même règle que l'état `unknown`
 * d'une base de données ou « en attente » d'un site suivi.
 */
export function statusTone(status: DeployStatus | null): 'neutral' | 'online' | 'danger' {
    if (status === 'success') return 'online';
    if (status === 'failed') return 'danger';
    return 'neutral';
}

/** « il y a 3 min », ou « jamais » — la même échelle que les autres features. */
export function formatAgo(at: number | null): string {
    if (at === null) return 'jamais déployé';
    const seconds = Math.max(0, Math.floor(Date.now() / 1000) - at);
    if (seconds < 60) return 'à l’instant';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `il y a ${minutes} min`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `il y a ${hours} h`;
    return `il y a ${Math.floor(hours / 24)} j`;
}

/** L'hôte seul : une liste n'a pas besoin du schéma ni du chemin. */
export function hostOf(baseUrl: string | null): string {
    if (!baseUrl) return 'instance inconnue';
    try {
        return new URL(baseUrl).host;
    } catch {
        return baseUrl;
    }
}
