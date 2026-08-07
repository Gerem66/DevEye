/**
 * Adaptateur Dokploy.
 *
 * **Calé sur une instance réelle**, et le résultat diffère nettement de ce que
 * décrit la documentation publique :
 *
 *  - La couche REST (`/api/application.list`, `/api/application.deploy`) n'y
 *    existe pas. Tout passe par **tRPC**, sous `/api/trpc/<procédure>`.
 *  - Les charges utiles sont enveloppées par **superjson** : une réponse est
 *    `{ result: { data: { json: … } } }`, une entrée `{ "json": { … } }`.
 *  - Il n'y a **pas** de `application.all`. Les cibles se découvrent par
 *    `project.all`, où elles sont imbriquées dans les environnements de chaque
 *    projet.
 *  - Une infra Dokploy est souvent majoritairement faite de piles **compose**,
 *    pas d'applications. Les ignorer reviendrait à ne rien pouvoir déployer.
 *
 * Le décodage reste **défensif** : les champs sont cherchés sous plusieurs noms
 * plausibles et retombent sur une valeur neutre s'ils manquent. Une instance
 * d'une autre version dégrade l'affichage, elle ne fait rien planter.
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

/** Ce qu'on déploie : une application, ou une pile compose. */
export type DokployKind = 'application' | 'compose';

export interface DokployTarget {
    kind: DokployKind;
    externalId: string;
    name: string;
    /** « Projet / environnement », tel que Dokploy l'organise. */
    path: string | null;
}

export interface DokployDeployment {
    externalId: string | null;
    /** Vocabulaire Dokploy, projeté sur le nôtre. */
    status: 'queued' | 'running' | 'success' | 'failed';
    title: string;
    description: string;
    startedAt: number;
    finishedAt: number | null;
}

function base(baseUrl: string): string {
    return `${baseUrl.replace(/\/+$/, '')}/api/trpc`;
}

async function call<T>(
    baseUrl: string,
    procedure: string,
    apiKey: string,
    options: { input?: unknown; mutate?: boolean } = {}
): Promise<T> {
    // superjson : l'entrée voyage sous une clé `json`, en query pour une
    // requête, en corps pour une mutation.
    const wrapped = options.input === undefined ? undefined : JSON.stringify({ json: options.input });
    const url =
        !options.mutate && wrapped !== undefined
            ? `${base(baseUrl)}/${procedure}?input=${encodeURIComponent(wrapped)}`
            : `${base(baseUrl)}/${procedure}`;

    let res: Response;
    try {
        res = await fetch(url, {
            method: options.mutate ? 'POST' : 'GET',
            headers: {
                accept: 'application/json',
                'x-api-key': apiKey,
                ...(options.mutate ? { 'content-type': 'application/json' } : {})
            },
            body: options.mutate ? (wrapped ?? '{"json":{}}') : undefined,
            signal: AbortSignal.timeout(30_000)
        });
    } catch (e) {
        throw new DokployError(e instanceof Error ? e.message : 'Instance Dokploy injoignable', 0);
    }

    let payload: unknown;
    try {
        payload = await res.json();
    } catch {
        throw new DokployError(`Réponse Dokploy illisible (HTTP ${res.status}).`, res.status);
    }

    // tRPC répond parfois 200 avec une erreur dans le corps : on lit l'erreur
    // avant le code HTTP.
    const err = readError(payload);
    if (err) throw new DokployError(err, res.status);
    if (!res.ok) throw new DokployError(`Dokploy a répondu ${res.status}.`, res.status);

    return unwrap(payload) as T;
}

function readError(payload: unknown): string | null {
    if (!payload || typeof payload !== 'object') return null;
    const raw = (payload as Record<string, unknown>).error;
    if (!raw || typeof raw !== 'object') return null;
    const e = (raw as Record<string, unknown>).json ?? raw;
    if (!e || typeof e !== 'object') return 'Erreur Dokploy.';
    const rec = e as Record<string, unknown>;
    const code = (rec.data as Record<string, unknown> | undefined)?.code;
    const message = typeof rec.message === 'string' ? rec.message : 'Erreur Dokploy.';
    if (code === 'UNAUTHORIZED' || code === 'FORBIDDEN') return 'Clé d’API refusée par Dokploy.';
    if (code === 'NOT_FOUND') return 'Procédure ou ressource introuvable sur cette instance Dokploy.';
    return message;
}

/** Déballe `{ result: { data: { json: … } } }`, en tolérant les variantes. */
function unwrap(payload: unknown): unknown {
    let current = payload;
    for (const key of ['result', 'data', 'json']) {
        if (current && typeof current === 'object' && key in (current as Record<string, unknown>)) {
            current = (current as Record<string, unknown>)[key];
        }
    }
    return current;
}

function asArray(value: unknown): Record<string, unknown>[] {
    return Array.isArray(value) ? (value as Record<string, unknown>[]) : [];
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
 * Aplatit `project.all` en cibles déployables.
 *
 * L'arborescence réelle est projet → environnements → { applications, compose }.
 * Les deux familles sont ramenées à la même forme, en gardant leur type : c'est
 * lui qui décidera de la procédure à appeler pour déployer.
 */
export function readTargets(payload: unknown): DokployTarget[] {
    const targets: DokployTarget[] = [];
    for (const project of asArray(payload)) {
        const projectName = pick(project, ['name']) ?? '';
        for (const env of asArray(project.environments)) {
            const envName = pick(env, ['name']) ?? '';
            const path = [projectName, envName].filter(Boolean).join(' / ') || null;

            for (const app of asArray(env.applications)) {
                const externalId = pick(app, ['applicationId', 'id']);
                if (externalId) {
                    targets.push({
                        kind: 'application',
                        externalId,
                        name: pick(app, ['name', 'appName']) ?? externalId,
                        path
                    });
                }
            }
            for (const compose of asArray(env.compose)) {
                const externalId = pick(compose, ['composeId', 'id']);
                if (externalId) {
                    targets.push({
                        kind: 'compose',
                        externalId,
                        name: pick(compose, ['name', 'appName']) ?? externalId,
                        path
                    });
                }
            }
        }
    }
    return targets;
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
    return asArray(payload).map((row) => {
        const status = readStatus(pick(row, ['status', 'state']));
        const startedAt = toSeconds(row.startedAt ?? row.createdAt ?? row.date) ?? Math.floor(Date.now() / 1000);
        const finishedAt = toSeconds(row.finishedAt ?? row.completedAt);
        // Le message d'erreur du fournisseur est plus utile que la description
        // d'origine quand le déploiement a échoué.
        const description = pick(row, ['errorMessage']) ?? pick(row, ['description', 'message']) ?? '';
        return {
            externalId: pick(row, ['deploymentId', 'id']),
            status,
            title: pick(row, ['title', 'name']) ?? 'Déploiement',
            description,
            startedAt,
            // Un déploiement en cours n'a pas de fin, même si l'instance
            // renvoie un horodatage qui bouge à chaque battement.
            finishedAt: status === 'running' || status === 'queued' ? null : finishedAt
        };
    });
}

export async function listTargets(baseUrl: string, apiKey: string): Promise<DokployTarget[]> {
    return readTargets(await call<unknown>(baseUrl, 'project.all', apiKey));
}

export async function listDeployments(
    baseUrl: string,
    apiKey: string,
    kind: DokployKind,
    externalId: string
): Promise<DokployDeployment[]> {
    const payload =
        kind === 'compose'
            ? await call<unknown>(baseUrl, 'deployment.allByCompose', apiKey, { input: { composeId: externalId } })
            : await call<unknown>(baseUrl, 'deployment.all', apiKey, { input: { applicationId: externalId } });
    return readDeployments(payload);
}

export async function triggerDeploy(
    baseUrl: string,
    apiKey: string,
    kind: DokployKind,
    externalId: string,
    title: string,
    description: string
): Promise<void> {
    const input =
        kind === 'compose'
            ? { composeId: externalId, title, description }
            : { applicationId: externalId, title, description };
    await call<unknown>(baseUrl, kind === 'compose' ? 'compose.deploy' : 'application.deploy', apiKey, {
        input,
        mutate: true
    });
}
