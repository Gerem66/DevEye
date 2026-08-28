import type { DeployStatus } from '../contracts/domain';

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

/**
 * Le message d'un échec côté Dokploy, tel quel.
 *
 * `humanizeError` (le barrel du SDK) ne rend le message du serveur que pour un
 * code `validation` ou `conflict`, pensé pour des refus de saisie, pas pour
 * « quelle instance, quelle route, quelle raison ». Ici l'échec vient presque
 * toujours du fournisseur (`internal` : instance injoignable, historique
 * introuvable, point d'entrée du journal refusé…) : le cacher derrière un
 * intitulé générique retirerait justement ce qui aide à comprendre quoi, côté
 * Dokploy, ne répond pas comme attendu.
 *
 * Le SDK n'exporte pas la classe d'erreur du socket : une réponse d'échec du
 * serveur se reconnaît à son `code` (toute erreur transportée en porte un), et
 * c'est son message qu'on montre. Une erreur de code (sans `code`) reste sur
 * l'intitulé de repli.
 */
export function dokployError(e: unknown, fallback: string): string {
    if (e instanceof Error && 'code' in e && e.message) return e.message;
    return fallback;
}

/**
 * Budget client pour un aller-retour Dokploy (`deploy.history`, `deploy.candidates`,
 * `deploy.trigger`) — au-delà du défaut de la socket (15 s) : le serveur borne
 * chaque appel à l'instance à 30 s (`AbortSignal.timeout` de l'adaptateur), et le
 * client doit laisser ce délai s'écouler avant de conclure à une panne plutôt que
 * d'abandonner avant lui.
 */
export const DOKPLOY_TIMEOUT_MS = 35_000;

/**
 * Budget client pour `deploy.log` : le serveur y enchaîne un aller-retour Dokploy
 * ({@link DOKPLOY_TIMEOUT_MS}) puis l'attente du flux de journaux (jusqu'à 30 s
 * de plus) — les deux doivent tenir dans ce délai.
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
