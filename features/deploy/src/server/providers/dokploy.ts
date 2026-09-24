import WebSocket from 'ws';

// Le garde des appels sortants, partagé par toute l'app : l'adresse de l'instance
// est saisie par un membre, et ses réponses lui reviennent.
import { isAllowedOutboundUrl, publicLookup, safeFetch, UnsafeTargetError } from '@/Services/netFetch';

/**
 * Adaptateur Dokploy, calé sur une instance réelle plutôt que sur la doc :
 *  - pas de couche REST, tout passe par tRPC sous `/api/trpc/<procédure>` ;
 *  - charges utiles enveloppées par superjson (`{ result: { data: { json } } }`
 *    en réponse, `{ json: … }` en entrée) ;
 *  - pas de `application.all` : les cibles se découvrent par `project.all`,
 *    imbriquées dans les environnements de chaque projet ;
 *  - les piles compose sont des cibles au même titre que les applications.
 *
 * Décodage défensif : champs cherchés sous plusieurs noms, valeur neutre s'ils
 * manquent. Une instance d'une autre version dégrade l'affichage sans planter.
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
    /**
     * Les trois niveaux séparés, en plus du chemin assemblé : un avis Discord
     * les montre en colonnes, et redécouper `path` serait faux dès qu'un nom
     * contient une barre oblique.
     */
    projectName: string | null;
    environmentName: string | null;
    /** De quoi reconstruire l'adresse de la fiche dans le tableau de bord. */
    projectId: string | null;
    environmentId: string | null;
}

export interface DokployDeployment {
    externalId: string | null;
    /** Vocabulaire Dokploy, projeté sur le nôtre. */
    status: 'queued' | 'running' | 'success' | 'failed';
    title: string;
    description: string;
    startedAt: number;
    finishedAt: number | null;
    /** Chemin du journal chez le fournisseur, pour {@link fetchDeploymentLog}. */
    logPath: string | null;
}

function base(baseUrl: string): string {
    return new URL('/api/trpc', baseUrl).toString().replace(/\/+$/, '');
}

/** Le délai d'une lecture, sauf mention contraire : celui d'un geste de l'utilisateur. */
const DEFAULT_TIMEOUT_MS = 30_000;

/** Un appel de fond se donne moins de temps qu'un geste, qui peut attendre. */
export interface DokployReadOptions {
    timeoutMs?: number;
}

async function call<T>(
    baseUrl: string,
    procedure: string,
    apiKey: string,
    options: { input?: unknown; mutate?: boolean; timeoutMs?: number } = {}
): Promise<T> {
    // superjson : l'entrée voyage sous une clé `json`, en query pour une
    // requête, en corps pour une mutation.
    const wrapped = options.input === undefined ? undefined : JSON.stringify({ json: options.input });
    const url =
        !options.mutate && wrapped !== undefined
            ? `${base(baseUrl)}/${procedure}?input=${encodeURIComponent(wrapped)}`
            : `${base(baseUrl)}/${procedure}`;

    let res: Awaited<ReturnType<typeof safeFetch>>;
    try {
        res = await safeFetch(url, {
            method: options.mutate ? 'POST' : 'GET',
            headers: {
                accept: 'application/json',
                'x-api-key': apiKey,
                ...(options.mutate ? { 'content-type': 'application/json' } : {})
            },
            body: options.mutate ? (wrapped ?? '{"json":{}}') : undefined,
            signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
        });
    } catch (e) {
        if (e instanceof UnsafeTargetError) throw new DokployError(e.message, 0);
        // Le détail d'une panne réseau reste au journal : renvoyé tel quel, il
        // dirait à l'appelant ce qui écoute ou non derrière l'adresse saisie.
        throw new DokployError('Instance Dokploy injoignable', 0);
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
 * Une URL de clone ramenée à une page web : `git@hote:o/r.git`,
 * `ssh://git@hote/o/r.git` et `https://hote/o/r.git` mènent à la même. Les
 * identifiants portés par l'URL sont retirés au passage : une URL de clone en
 * contient parfois un, et il n'a rien à faire dans un salon. `null` pour ce qui
 * n'a pas d'équivalent web.
 */
export function webGitUrl(clone: string | null): string | null {
    const raw = (clone ?? '').trim();
    if (!raw) return null;

    // La forme SCP de SSH (`git@hote:chemin`) n'est pas une URL : `new URL` la
    // lirait comme un protocole.
    const scp = /^[\w.-]+@([\w.-]+):(?!\/)(.+)$/.exec(raw);

    let url: URL;
    try {
        url = new URL(scp ? `ssh://${scp[1]}/${scp[2]}` : raw);
    } catch {
        return null;
    }
    if (!['http:', 'https:', 'ssh:'].includes(url.protocol)) return null;

    const path = url.pathname.replace(/\.git\/*$/, '').replace(/\/+$/, '');
    if (!path) return null;
    // Le port d'un accès SSH n'est pas celui du web ; celui d'un HTTP l'est.
    const host = url.protocol === 'ssh:' ? url.hostname : url.host;
    return `${url.protocol === 'http:' ? 'http' : 'https'}://${host}${path}`;
}

/**
 * Le dépôt d'une cible, lu sur sa fiche.
 *
 * Deux sources : `owner`/`repository`, que remplit l'intégration GitHub, et
 * `customGitUrl`, dont l'hôte est dans l'URL. GitLab et Gitea demanderaient en
 * plus l'hôte de leur fournisseur, imbriqué dans la fiche sous une forme qui n'a
 * pas été relevée : un lien deviné vaudrait moins que pas de lien.
 */
export function readRepoUrl(row: Record<string, unknown>): string | null {
    // Les colonnes d'une source abandonnée restent en base après un changement :
    // on ne lit celles d'une source que si c'est bien celle qui est active.
    const source = pick(row, ['sourceType']);
    if (source === 'git') return webGitUrl(pick(row, ['customGitUrl']));
    if (source !== null && source !== 'github') return null;

    const owner = pick(row, ['owner']);
    const repository = pick(row, ['repository']);
    return owner && repository ? `https://github.com/${owner}/${repository}` : null;
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

            const place = {
                path,
                projectName: projectName || null,
                environmentName: envName || null,
                projectId: pick(project, ['projectId', 'id']),
                environmentId: pick(env, ['environmentId', 'id'])
            };

            for (const app of asArray(env.applications)) {
                const externalId = pick(app, ['applicationId', 'id']);
                if (externalId) {
                    targets.push({
                        kind: 'application',
                        externalId,
                        name: pick(app, ['name', 'appName']) ?? externalId,
                        ...place
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
                        ...place
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
            finishedAt: status === 'running' || status === 'queued' ? null : finishedAt,
            logPath: pick(row, ['logPath'])
        };
    });
}

/**
 * L'adresse de la fiche d'une cible dans le tableau de bord Dokploy. Relevée
 * sur l'instance (cette forme répond 307, les autres 404) : un lien faux serait
 * pire que pas de lien. `null` dès qu'un identifiant manque.
 */
export function dashboardUrl(baseUrl: string, target: DokployTarget): string | null {
    if (!target.projectId || !target.environmentId) return null;
    const root = baseUrl.replace(/\/+$/, '');
    return `${root}/dashboard/project/${target.projectId}/environment/${target.environmentId}/services/${target.kind}/${target.externalId}`;
}

export async function listTargets(
    baseUrl: string,
    apiKey: string,
    options: DokployReadOptions = {}
): Promise<DokployTarget[]> {
    return readTargets(await call<unknown>(baseUrl, 'project.all', apiKey, options));
}

export async function listDeployments(
    baseUrl: string,
    apiKey: string,
    kind: DokployKind,
    externalId: string,
    options: DokployReadOptions = {}
): Promise<DokployDeployment[]> {
    const payload =
        kind === 'compose'
            ? await call<unknown>(baseUrl, 'deployment.allByCompose', apiKey, {
                  ...options,
                  input: { composeId: externalId }
              })
            : await call<unknown>(baseUrl, 'deployment.all', apiKey, {
                  ...options,
                  input: { applicationId: externalId }
              });
    return readDeployments(payload);
}

/**
 * Le dépôt d'une cible. `project.all` ne le dit pas : relevé sur l'instance, il
 * ne rend d'une application que son identifiant, son nom et son état. C'est la
 * fiche qui porte la source, d'où un appel par cible.
 *
 * ⚠️ `application.one` rend AUSSI le fournisseur Git au complet, clé privée et
 * secret client de l'app GitHub compris. Rien de cette réponse ne doit être
 * gardé, journalisé ni mis en cache : seule l'adresse du dépôt en sort.
 */
export async function fetchRepoUrl(
    baseUrl: string,
    apiKey: string,
    kind: DokployKind,
    externalId: string,
    options: DokployReadOptions = {}
): Promise<string | null> {
    const row =
        kind === 'compose'
            ? await call<unknown>(baseUrl, 'compose.one', apiKey, { ...options, input: { composeId: externalId } })
            : await call<unknown>(baseUrl, 'application.one', apiKey, {
                  ...options,
                  input: { applicationId: externalId }
              });
    return row && typeof row === 'object' ? readRepoUrl(row as Record<string, unknown>) : null;
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

/** `/listen-deployment?logPath=…`, jamais sous `/api/trpc`. */
function logSocketUrl(baseUrl: string, logPath: string): string {
    const url = new URL(baseUrl.replace(/\/+$/, ''));
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.pathname = '/listen-deployment';
    url.search = `?logPath=${encodeURIComponent(logPath)}`;
    return url.toString();
}

/** Plafond absolu : au-delà, on rend ce qu'on a, quoi qu'il arrive. */
const LOG_TIMEOUT_MS = 30_000;

/**
 * Silence après le dernier octet au bout duquel le journal est réputé complet.
 * C'est ce qui décide du temps d'ouverture de la popup : un journal complet
 * arrive en un seul message, ~200 ms après l'ouverture, puis plus rien.
 */
const LOG_IDLE_MS = 1_000;

/**
 * Rejoue le journal d'un déploiement tel que Dokploy le stream, par un
 * WebSocket dédié hors de `call()` (aucune procédure tRPC ne le rend, route
 * non documentée). Deux garde-fous :
 *  - `x-api-key` est posé, mais rien ne garantit que cette route l'exige ;
 *    une instance qui la refuse remonte une erreur normale ;
 *  - le serveur ne referme jamais la socket (`/listen-deployment` est un
 *    `tail -f`) : c'est le silence après le dernier octet ({@link LOG_IDLE_MS})
 *    qui conclut, et `timeoutMs` reste le plafond pour un déploiement en cours,
 *    qui émet sans discontinuer.
 */
export function fetchDeploymentLog(
    baseUrl: string,
    apiKey: string,
    logPath: string,
    options: { timeoutMs?: number } = {}
): Promise<string> {
    return new Promise((resolve, reject) => {
        if (!isAllowedOutboundUrl(baseUrl)) {
            reject(new UnsafeTargetError());
            return;
        }
        const socket = new WebSocket(logSocketUrl(baseUrl, logPath), {
            headers: { 'x-api-key': apiKey },
            lookup: publicLookup as never
        });
        const chunks: string[] = [];
        let settled = false;
        let idle: ReturnType<typeof setTimeout> | null = null;

        // Le plafond borne le pire cas (flux continu ou muet), le repos conclut
        // le cas courant, dès que le fichier a fini d'être rejoué.
        const cap = setTimeout(() => finish(), options.timeoutMs ?? LOG_TIMEOUT_MS);

        function finish(err?: Error): void {
            if (settled) return;
            settled = true;
            clearTimeout(cap);
            if (idle) clearTimeout(idle);
            socket.terminate();
            // Un lot déjà reçu vaut mieux qu'une erreur : un journal partiel
            // reste lisible, une page vide sur une simple coupure ne l'est pas.
            if (err && chunks.length === 0) reject(err);
            else resolve(chunks.join(''));
        }

        socket.on('message', (data) => {
            chunks.push(
                Buffer.isBuffer(data) ? data.toString('utf8') : Buffer.from(data as ArrayBuffer).toString('utf8')
            );
            // Réarmé à chaque morceau : un journal qui arrive en plusieurs
            // trames n'est conclu qu'après le silence qui suit la dernière.
            if (idle) clearTimeout(idle);
            idle = setTimeout(() => finish(), LOG_IDLE_MS);
        });
        socket.on('close', () => finish());
        socket.on('error', (err) => finish(err));
    });
}
