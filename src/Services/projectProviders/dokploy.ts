/**
 * Adaptateur Dokploy.
 *
 * **Ce qui est vérifié** contre la documentation officielle : l'authentification
 * par en-tête `x-api-key` (jeton engendré dans `/settings/profile`, section
 * API/CLI), et les chemins —
 *
 *   GET  /api/application.list
 *   GET  /api/application.one?applicationId=…
 *   POST /api/application.deploy      { applicationId, title?, description? }
 *   GET  /api/deployment.all?applicationId=…
 *
 * **Ce qui ne l'est pas** : la forme exacte des corps de réponse, qui dépend de
 * la version de l'instance. Tout le décodage ci-dessous est donc **défensif** —
 * chaque champ est cherché sous plusieurs noms plausibles et retombe sur une
 * valeur neutre s'il manque. Une instance qui répond autrement dégrade
 * l'affichage, elle ne fait rien planter.
 *
 * Pour caler précisément : `curl -H 'x-api-key: …' https://<instance>/api/openapi.json`,
 * et resserrer {@link readApplications} / {@link readDeployments} sur ce que
 * l'instance annonce réellement.
 */

export class DokployError extends Error {
    constructor(
        message: string,
        readonly status: number
    ) {
        super(message);
        this.name = 'DokployError';
    }
}

export interface DokployApplication {
    externalId: string;
    name: string;
    path: string | null;
}

export interface DokployDeployment {
    externalId: string | null;
    /** Vocabulaire Dokploy, projeté plus haut sur `DeployStatus`. */
    status: 'queued' | 'running' | 'success' | 'failed';
    title: string;
    description: string;
    startedAt: number;
    finishedAt: number | null;
}

function base(baseUrl: string): string {
    return baseUrl.replace(/\/+$/, '');
}

async function call<T>(
    baseUrl: string,
    path: string,
    apiKey: string,
    init?: { method: 'POST'; body: unknown }
): Promise<T> {
    let res: Response;
    try {
        res = await fetch(`${base(baseUrl)}${path}`, {
            method: init?.method ?? 'GET',
            headers: {
                accept: 'application/json',
                'x-api-key': apiKey,
                ...(init ? { 'content-type': 'application/json' } : {})
            },
            body: init ? JSON.stringify(init.body) : undefined,
            signal: AbortSignal.timeout(30_000)
        });
    } catch (e) {
        throw new DokployError(e instanceof Error ? e.message : 'Instance Dokploy injoignable', 0);
    }

    if (!res.ok) {
        const message =
            res.status === 401 || res.status === 403
                ? 'Clé d’API refusée par Dokploy.'
                : res.status === 404
                  ? 'Ressource introuvable sur cette instance Dokploy.'
                  : `Dokploy a répondu ${res.status}.`;
        throw new DokployError(message, res.status);
    }

    try {
        return (await res.json()) as T;
    } catch {
        throw new DokployError('Réponse Dokploy illisible.', res.status);
    }
}

/** Le premier champ présent parmi plusieurs noms plausibles. */
function pick(row: Record<string, unknown>, keys: string[]): string | null {
    for (const key of keys) {
        const value = row[key];
        if (typeof value === 'string' && value.length > 0) return value;
    }
    return null;
}

function toSeconds(value: unknown): number | null {
    if (typeof value === 'number') return value > 1e11 ? Math.floor(value / 1000) : Math.floor(value);
    if (typeof value === 'string') {
        const ms = new Date(value).getTime();
        return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
    }
    return null;
}

/**
 * Certaines instances rendent un tableau nu, d'autres l'enveloppent (`data`,
 * `result`, `json`). On déballe plutôt que de supposer.
 */
function unwrapArray(payload: unknown): Record<string, unknown>[] {
    if (Array.isArray(payload)) return payload as Record<string, unknown>[];
    if (payload && typeof payload === 'object') {
        for (const key of ['data', 'result', 'json', 'items']) {
            const inner = (payload as Record<string, unknown>)[key];
            if (Array.isArray(inner)) return inner as Record<string, unknown>[];
            // tRPC enveloppe parfois deux fois : { result: { data: [...] } }
            if (inner && typeof inner === 'object') {
                const deeper = unwrapArray(inner);
                if (deeper.length > 0) return deeper;
            }
        }
    }
    return [];
}

export function readApplications(payload: unknown): DokployApplication[] {
    return unwrapArray(payload)
        .map((row) => {
            const externalId = pick(row, ['applicationId', 'id', 'appId']);
            if (!externalId) return null;
            return {
                externalId,
                name: pick(row, ['name', 'appName', 'title']) ?? externalId,
                path: pick(row, ['projectName', 'environmentName', 'description'])
            };
        })
        .filter((a): a is DokployApplication => a !== null);
}

/**
 * Projette le vocabulaire d'état de Dokploy sur le nôtre.
 *
 * Un état inconnu est traité comme « en cours » plutôt que comme un échec : se
 * tromper en annonçant une panne est pire que d'attendre un tour de plus.
 */
function readStatus(raw: string | null): DokployDeployment['status'] {
    const value = (raw ?? '').toLowerCase();
    if (['done', 'success', 'succeeded', 'completed', 'ok'].includes(value)) return 'success';
    if (['error', 'failed', 'failure', 'cancelled', 'canceled'].includes(value)) return 'failed';
    if (['idle', 'queued', 'pending', 'waiting'].includes(value)) return 'queued';
    return 'running';
}

export function readDeployments(payload: unknown): DokployDeployment[] {
    return unwrapArray(payload).map((row) => {
        const status = readStatus(pick(row, ['status', 'state']));
        const startedAt = toSeconds(row.createdAt ?? row.startedAt ?? row.date) ?? Math.floor(Date.now() / 1000);
        const finishedAt = toSeconds(row.finishedAt ?? row.completedAt ?? row.updatedAt);
        return {
            externalId: pick(row, ['deploymentId', 'id']),
            status,
            title: pick(row, ['title', 'name']) ?? 'Déploiement',
            description: pick(row, ['description', 'message']) ?? '',
            startedAt,
            // Un déploiement encore en cours n'a pas de fin, même si l'instance
            // renvoie un `updatedAt` qui bouge à chaque battement.
            finishedAt: status === 'running' || status === 'queued' ? null : finishedAt
        };
    });
}

export async function listApplications(baseUrl: string, apiKey: string): Promise<DokployApplication[]> {
    return readApplications(await call<unknown>(baseUrl, '/api/application.list', apiKey));
}

export async function listDeployments(
    baseUrl: string,
    apiKey: string,
    applicationId: string
): Promise<DokployDeployment[]> {
    const payload = await call<unknown>(
        baseUrl,
        `/api/deployment.all?applicationId=${encodeURIComponent(applicationId)}`,
        apiKey
    );
    return readDeployments(payload);
}

export async function triggerDeploy(
    baseUrl: string,
    apiKey: string,
    applicationId: string,
    title: string,
    description: string
): Promise<void> {
    await call<unknown>(baseUrl, '/api/application.deploy', apiKey, {
        method: 'POST',
        body: { applicationId, title, description }
    });
}
