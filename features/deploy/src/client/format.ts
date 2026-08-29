import type { DeployStatus } from '../contracts/domain';

/** Le vocabulaire d'état, un seul jeu pour toute la feature. */
export const STATUS_LABELS: Record<DeployStatus, string> = {
    queued: 'En attente',
    running: 'En cours',
    success: 'Réussi',
    failed: 'Échoué'
};

/**
 * La teinte d'un état. « En attente » et « En cours » sont neutres : les états
 * normaux d'un déploiement qui vient de partir, pas un incident.
 */
export function statusTone(status: DeployStatus | null): 'neutral' | 'online' | 'danger' {
    if (status === 'success') return 'online';
    if (status === 'failed') return 'danger';
    return 'neutral';
}

/** « il y a 3 min », ou « jamais ». */
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

/**
 * Le message d'un échec côté Dokploy, tel quel. `humanizeError` ne rend le
 * message du serveur que pour `validation` ou `conflict` ; ici l'échec vient du
 * fournisseur (`internal`), et son message est la seule piste. Une réponse
 * d'échec se reconnaît à son `code` ; une erreur de code garde le repli.
 */
export function dokployError(e: unknown, fallback: string): string {
    if (e instanceof Error && 'code' in e && e.message) return e.message;
    return fallback;
}

/**
 * Budget client pour un aller-retour Dokploy, au-delà du défaut de la socket
 * (15 s) : le serveur borne chaque appel à l'instance à 30 s, et le client doit
 * laisser ce délai s'écouler avant de conclure à une panne.
 */
export const DOKPLOY_TIMEOUT_MS = 35_000;

/**
 * Budget client pour `deploy.log` : un aller-retour Dokploy
 * ({@link DOKPLOY_TIMEOUT_MS}) puis l'attente du flux de journaux (30 s de plus).
 */
export const DOKPLOY_LOG_TIMEOUT_MS = 65_000;

/** L'hôte seul : une liste n'a pas besoin du schéma ni du chemin. */
export function hostOf(baseUrl: string | null): string {
    if (!baseUrl) return 'instance inconnue';
    try {
        return new URL(baseUrl).host;
    } catch {
        return baseUrl;
    }
}
