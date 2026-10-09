import type { UptimeDeployCandidateKind, UptimeDeploySource, UptimePoint, UptimeRange } from '../contracts/domain';
import { formatDuration } from '../contracts/format';

const DAY = 86400;

/** The ranges offered by the detail view's selector, in order. */
export const RANGES: { value: UptimeRange; label: string }[] = [
    { value: '24h', label: '24 h' },
    { value: '7d', label: '7 j' },
    { value: '30d', label: '30 j' },
    { value: '90d', label: '90 j' },
    { value: '1y', label: '1 an' },
    { value: 'all', label: 'Tout' }
];

/** Seconds a range covers; `null` for "Tout", which the data itself bounds. */
const RANGE_SECONDS: Record<UptimeRange, number | null> = {
    '24h': DAY,
    '7d': 7 * DAY,
    '30d': 30 * DAY,
    '90d': 90 * DAY,
    '1y': 365 * DAY,
    all: null
};

/**
 * The time window a range actually spans : the shared x-axis of the status strip
 * and the latency curve.
 *
 * It is the **selected duration**, not the extent of the data: a service added
 * ten minutes ago must show 24 h of "no data" behind its first samples, not
 * stretch ten minutes across the whole width. "Tout" is the exception, having no
 * duration of its own, so the oldest sample opens it.
 */
export function rangeWindow(range: UptimeRange, points: UptimePoint[]): { from: number; to: number } {
    const to = Math.floor(Date.now() / 1000);
    const span = RANGE_SECONDS[range];
    if (span !== null) return { from: to - span, to };
    return { from: points[0]?.at ?? to - DAY, to };
}

/** "31/07/2026 14:32:05". */
export function formatMoment(epochSeconds: number): string {
    return new Date(epochSeconds * 1000).toLocaleString('fr-FR', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
    });
}

/** "il y a 3 min" : how long ago a check happened. */
export function formatAgo(epochSeconds: number | null): string {
    if (epochSeconds === null) return 'jamais testé';
    const delta = Math.max(0, Math.floor(Date.now() / 1000) - epochSeconds);
    return delta < 10 ? "à l'instant" : `il y a ${formatDuration(delta)}`;
}

/** Axis label matching a bucket size: a time for raw/hour points, a date for days. */
export function formatBucket(epochSeconds: number, daily: boolean): string {
    const date = new Date(epochSeconds * 1000);
    return daily
        ? date.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: '2-digit' })
        : date.toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

/** Les quatre réglages fins d'un service : le panneau Général les édite, un service neuf reçoit leurs défauts. */
export interface ServiceTuning {
    intervalSeconds: number;
    timeoutSeconds: number;
    failureThreshold: number;
    retentionDays: number | null;
}

/** Un champ numérique ramené dans ses bornes ; vide ou illisible vaut le minimum. */
export function clamp(raw: string, min: number, max: number): number {
    return Math.min(max, Math.max(min, Number(raw) || min));
}

/** La zone « un chemin par ligne » en liste : vides et doublons écartés. */
export function parsePaths(text: string): string[] {
    return [
        ...new Set(
            text
                .split(/\r?\n/)
                .map((line) => line.trim())
                .filter(Boolean)
        )
    ];
}

/** Les catégories du sélecteur des sources de déploiement. */
export const DEPLOY_GROUPS: Record<UptimeDeployCandidateKind, string> = {
    project: 'Projets',
    deploy: 'Déploiements',
    git: 'Dépôts Git',
    hook: 'Adresse d’appel'
};

export const DEPLOY_ICONS: Record<UptimeDeployCandidateKind, string> = {
    project: 'projects',
    deploy: 'rocket',
    git: 'branch',
    hook: 'key'
};

/** La valeur d'une entrée du sélecteur : `deploy:5`, ou `hook` pour l'adresse du service. */
export function deployKey(kind: UptimeDeployCandidateKind, id: number | null): string {
    return id === null ? kind : `${kind}:${id}`;
}

/** Ce qu'un service a choisi, en valeurs du sélecteur. */
export function deployKeysOf(sources: readonly UptimeDeploySource[], hook: boolean): string[] {
    return [...sources.map((s) => deployKey(s.kind, s.id)), ...(hook ? ['hook'] : [])];
}

/** Les valeurs du sélecteur en ce qu'attend `uptime.update`. */
export function deploySettingsOf(keys: readonly string[]): {
    deploySources: UptimeDeploySource[];
    deployHook: boolean;
} {
    const deploySources: UptimeDeploySource[] = [];
    for (const key of keys) {
        const [kind, id] = key.split(':');
        if ((kind === 'project' || kind === 'deploy' || kind === 'git') && Number(id) > 0) {
            deploySources.push({ kind, id: Number(id) });
        }
    }
    return { deploySources, deployHook: keys.includes('hook') };
}
