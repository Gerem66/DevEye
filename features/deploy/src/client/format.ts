import type { DeployProvider, DeployStatus, DeployTarget, DeployTargetKind } from '../contracts/domain';

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
    return `il y a ${formatSpan(seconds)}`;
}

/** « depuis 3 min », pour un état qui dure. */
export function formatSince(at: number): string {
    const seconds = Math.max(0, Math.floor(Date.now() / 1000) - at);
    if (seconds < 60) return 'depuis moins d’une minute';
    return `depuis ${formatSpan(seconds)}`;
}

function formatSpan(seconds: number): string {
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes} min`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} h`;
    return `${Math.floor(hours / 24)} j`;
}

/**
 * Le message d'un échec côté fournisseur, tel quel. `humanizeError` ne rend le
 * message du serveur que pour `validation` ou `conflict` ; ici l'échec vient du
 * fournisseur (`internal`), et son message est la seule piste. Une réponse
 * d'échec se reconnaît à son `code` ; une erreur de code garde le repli.
 */
export function providerError(e: unknown, fallback: string): string {
    if (e instanceof Error && 'code' in e && e.message) return e.message;
    return fallback;
}

/**
 * Budget client pour un aller-retour chez le fournisseur, au-delà du défaut de
 * la socket (15 s) : le serveur borne chaque appel à 30 s, et le client doit
 * laisser ce délai s'écouler avant de conclure à une panne.
 */
export const PROVIDER_TIMEOUT_MS = 35_000;

/**
 * Budget client pour `deploy.log` : un aller-retour chez le fournisseur
 * ({@link PROVIDER_TIMEOUT_MS}) puis la lecture du journal (30 s de plus).
 */
export const LOG_TIMEOUT_MS = 65_000;

export const PROVIDER_LABELS: Record<DeployProvider, string> = {
    dokploy: 'Dokploy',
    github: 'GitHub',
    agent: 'une machine'
};

/**
 * Une cible qui a perdu son accès : elle reste, indéployable, et le dit. Une
 * cible portée par une machine n'en a jamais eu.
 */
export function isOrphan(target: Pick<DeployTarget, 'provider' | 'credentialId'>): boolean {
    return target.provider !== 'agent' && target.credentialId === null;
}

/**
 * Les deux genres de cible d'une instance Dokploy, tous deux visibles : deux
 * choix fixes, un segment chacun plutôt qu'un déroulant qui les cacherait
 * derrière un clic. Un workflow GitHub n'a pas de choix à faire.
 */
export const DOKPLOY_KIND_OPTIONS: readonly { value: DeployTargetKind; label: string; title: string }[] = [
    { value: 'application', label: 'Application', title: 'Une application Dokploy (application.deploy)' },
    { value: 'compose', label: 'Pile compose', title: 'Une pile Docker Compose (compose.deploy)' }
];

const KIND_LABELS: Record<DeployTargetKind, string> = {
    application: 'application',
    compose: 'pile compose',
    workflow: 'workflow GitHub',
    service: 'service compose'
};

/** Le type et le lieu d'une cible, sur une ligne : « pile compose · dokploy.exemple.fr ». */
export function targetWhere(target: Pick<DeployTarget, 'kind' | 'location'>): string {
    return `${KIND_LABELS[target.kind]} · ${target.location ?? 'lieu inconnu'}`;
}
