import { connect as netConnect } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { Agent, buildConnector, fetch as undiciFetch, type RequestInit } from 'undici';
import WebSocket, { type ClientOptions } from 'ws';

import type { DeployCandidate } from '../../contracts/domain';
import { openDeviceTunnel, type DeviceRelay } from '@deveye/types/sdk/server';

// Le garde des appels sortants, partagé par toute l'app : l'adresse de l'instance
// est saisie par un membre, et ses réponses lui reviennent.
import { isAllowedOutboundUrl, publicLookup, safeFetch, UnsafeTargetError } from '@/Services/netFetch';

import {
    ProviderError,
    type DeployProviderAdapter,
    type ProviderAccess,
    type ProviderTarget,
    type ReadOptions,
    type RemoteDeployment,
    type TargetPlace
} from './types';

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

/** Ce qu'un appareil joint, dans les messages du relais. */
export const DOKPLOY_INSTANCE = 'cette instance Dokploy';

/**
 * Une instance à joindre : par le serveur, sous le garde des appels sortants,
 * ou par l'agent d'un appareil (`relay`), qui seul borne alors ce qu'il
 * atteint ; `baseUrl` est dans ce cas l'adresse telle que la machine la voit.
 */
export interface DokployInstance {
    baseUrl: string;
    apiKey: string;
    relay: DeviceRelay | null;
}

function base(baseUrl: string): string {
    return new URL('/api/trpc', baseUrl).toString().replace(/\/+$/, '');
}

/** L'hôte et le port de l'instance, tels que l'appareil les joint. */
function endpointOf(baseUrl: string): { host: string; port: number } {
    const url = new URL(baseUrl);
    return { host: url.hostname, port: Number(url.port) || (url.protocol === 'https:' ? 443 : 80) };
}

/** Le délai d'une lecture, sauf mention contraire : celui d'un geste de l'utilisateur. */
const DEFAULT_TIMEOUT_MS = 30_000;

interface RawResponse {
    status: number;
    ok: boolean;
    text: string;
}

/** Ce qu'un appel fixe de sa requête ; le transport choisit le reste (redirections, dispatcher). */
type CallInit = Pick<RequestInit, 'method' | 'headers' | 'body' | 'signal'>;

/** Une requête par le serveur : le garde vérifie l'adresse et chaque redirection. */
async function directRequest(url: string, init: CallInit): Promise<RawResponse> {
    const res = await safeFetch(url, init);
    return { status: res.status, ok: res.ok, text: await res.text() };
}

/**
 * Une requête par l'appareil : un écouteur local relaie vers l'instance, et le
 * connecteur d'undici s'y branche à la place de l'hôte, le nom de l'instance
 * gardé pour TLS. Hors du garde, une redirection n'est pas suivie : elle
 * mènerait où l'instance veut. Le corps est lu avant de refermer le relais.
 */
async function relayedRequest(
    instance: DokployInstance,
    relay: DeviceRelay,
    url: string,
    init: CallInit
): Promise<RawResponse> {
    const tunnel = await openDeviceTunnel(relay, endpointOf(instance.baseUrl), DOKPLOY_INSTANCE);
    const direct = buildConnector({});
    const dispatcher = new Agent({
        connect: (options, callback) =>
            direct({ ...options, hostname: tunnel.host, port: String(tunnel.port) }, callback)
    });
    try {
        const res = await undiciFetch(url, { ...init, dispatcher, redirect: 'manual' });
        if (res.status >= 300 && res.status < 400) {
            throw new ProviderError(
                `L’instance redirige ailleurs (HTTP ${res.status}) : donnez son adresse finale.`,
                res.status
            );
        }
        return { status: res.status, ok: res.ok, text: await res.text() };
    } finally {
        await dispatcher.close();
        await tunnel.close();
    }
}

async function call<T>(
    instance: DokployInstance,
    procedure: string,
    options: { input?: unknown; mutate?: boolean; timeoutMs?: number } = {}
): Promise<T> {
    // superjson : l'entrée voyage sous une clé `json`, en query pour une
    // requête, en corps pour une mutation.
    const wrapped = options.input === undefined ? undefined : JSON.stringify({ json: options.input });
    const url =
        !options.mutate && wrapped !== undefined
            ? `${base(instance.baseUrl)}/${procedure}?input=${encodeURIComponent(wrapped)}`
            : `${base(instance.baseUrl)}/${procedure}`;
    const init: CallInit = {
        method: options.mutate ? 'POST' : 'GET',
        headers: {
            accept: 'application/json',
            'x-api-key': instance.apiKey,
            ...(options.mutate ? { 'content-type': 'application/json' } : {})
        },
        body: options.mutate ? (wrapped ?? '{"json":{}}') : undefined,
        signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    };

    let res: RawResponse;
    try {
        res = instance.relay
            ? await relayedRequest(instance, instance.relay, url, init)
            : await directRequest(url, init);
    } catch (e) {
        if (e instanceof ProviderError) throw e;
        if (e instanceof UnsafeTargetError) throw new ProviderError(e.message, 0);
        // Le détail d'une panne réseau reste au journal : renvoyé tel quel, il
        // dirait à l'appelant ce qui écoute ou non derrière l'adresse saisie.
        // Le relais, lui, parle : appareil hors ligne, cible refusée par l'agent.
        if (instance.relay && e instanceof Error) throw new ProviderError(e.message, 0);
        throw new ProviderError('Instance Dokploy injoignable', 0);
    }

    let payload: unknown;
    try {
        payload = JSON.parse(res.text);
    } catch {
        throw new ProviderError(`Réponse Dokploy illisible (HTTP ${res.status}).`, res.status);
    }

    // tRPC répond parfois 200 avec une erreur dans le corps : on lit l'erreur
    // avant le code HTTP.
    const err = readError(payload);
    if (err) throw new ProviderError(err, res.status);
    if (!res.ok) throw new ProviderError(`Dokploy a répondu ${res.status}.`, res.status);

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
function readStatus(raw: string | null): RemoteDeployment['status'] {
    const value = (raw ?? '').toLowerCase();
    if (['done', 'success', 'succeeded', 'completed', 'ok'].includes(value)) return 'success';
    if (['error', 'failed', 'failure', 'cancelled', 'canceled'].includes(value)) return 'failed';
    if (['idle', 'queued', 'pending', 'waiting'].includes(value)) return 'queued';
    return 'running';
}

export function readDeployments(payload: unknown): RemoteDeployment[] {
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
            logRef: pick(row, ['logPath']),
            url: null,
            details: []
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

export async function listTargets(instance: DokployInstance, options: ReadOptions = {}): Promise<DokployTarget[]> {
    return readTargets(await call<unknown>(instance, 'project.all', options));
}

export async function listDeployments(
    instance: DokployInstance,
    kind: DokployKind,
    externalId: string,
    options: ReadOptions = {}
): Promise<RemoteDeployment[]> {
    const payload =
        kind === 'compose'
            ? await call<unknown>(instance, 'deployment.allByCompose', { ...options, input: { composeId: externalId } })
            : await call<unknown>(instance, 'deployment.all', { ...options, input: { applicationId: externalId } });
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
    instance: DokployInstance,
    kind: DokployKind,
    externalId: string,
    options: ReadOptions = {}
): Promise<string | null> {
    const row =
        kind === 'compose'
            ? await call<unknown>(instance, 'compose.one', { ...options, input: { composeId: externalId } })
            : await call<unknown>(instance, 'application.one', { ...options, input: { applicationId: externalId } });
    return row && typeof row === 'object' ? readRepoUrl(row as Record<string, unknown>) : null;
}

export async function triggerDeploy(
    instance: DokployInstance,
    kind: DokployKind,
    externalId: string,
    title: string,
    description: string
): Promise<void> {
    const input =
        kind === 'compose'
            ? { composeId: externalId, title, description }
            : { applicationId: externalId, title, description };
    await call<unknown>(instance, kind === 'compose' ? 'compose.deploy' : 'application.deploy', {
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
 * C'est ce qui décide du temps d'ouverture de la popup : le rejeu du fichier
 * arrive en une rafale de trames à quelques millisecondes d'écart (un
 * `tail -n +1 -f` côté Dokploy), puis plus rien. Un déploiement en cours rend
 * ce qu'il a au premier silence ; le client le relit ensuite.
 */
const LOG_IDLE_MS = 300;

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
export async function fetchDeploymentLog(
    instance: DokployInstance,
    logPath: string,
    options: { timeoutMs?: number } = {}
): Promise<string> {
    if (!instance.relay) {
        if (!isAllowedOutboundUrl(instance.baseUrl)) throw new UnsafeTargetError();
        return readLogSocket(instance, logPath, { lookup: publicLookup as never }, options);
    }
    // Par l'appareil : la socket se branche sur le relais local, le nom de
    // l'instance gardé pour TLS. `path` est celui de l'URL, que `tls.connect`
    // prendrait pour un chemin de socket Unix.
    const tunnel = await openDeviceTunnel(instance.relay, endpointOf(instance.baseUrl), DOKPLOY_INSTANCE);
    const secure = new URL(instance.baseUrl).protocol === 'https:';
    try {
        return await readLogSocket(
            instance,
            logPath,
            {
                createConnection: (connection) => {
                    const target = { ...connection, host: tunnel.host, port: tunnel.port, path: undefined };
                    return secure ? tlsConnect({ ...target, servername: connection.host }) : netConnect(target);
                }
            },
            options
        );
    } finally {
        await tunnel.close();
    }
}

function readLogSocket(
    instance: DokployInstance,
    logPath: string,
    transport: ClientOptions,
    options: { timeoutMs?: number }
): Promise<string> {
    return new Promise((resolve, reject) => {
        const socket = new WebSocket(logSocketUrl(instance.baseUrl, logPath), {
            headers: { 'x-api-key': instance.apiKey },
            ...transport
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

/**
 * Durée de vie du catalogue d'une instance (`project.all`, un appel pour toute
 * l'instance) : des noms d'organisation, qui ne bougent pas, et les redemander
 * à chaque battement coûterait un appel permanent.
 */
const PLACE_TTL_SECONDS = 300;

/**
 * Durée de vie du dépôt d'une cible. Un appel par cible, contrairement au
 * catalogue : plus long, parce qu'un dépôt bouge encore moins qu'un nom de
 * projet, et qu'une heure borne l'écart après un changement de source.
 */
const REPO_TTL_SECONDS = 3600;

/** Le catalogue et la fiche ne se lisent que pour l'avis, en tâche de fond : le délai du suivi. */
const BACKGROUND_TIMEOUT_MS = 10_000;

/** Les appels réseau de l'adaptateur, remplaçables : un test simule une instance sans réseau. */
export interface DokployClient {
    listTargets: typeof listTargets;
    listDeployments: typeof listDeployments;
    triggerDeploy: typeof triggerDeploy;
    fetchDeploymentLog: typeof fetchDeploymentLog;
    fetchRepoUrl: typeof fetchRepoUrl;
}

const NETWORK: DokployClient = { listTargets, listDeployments, triggerDeploy, fetchDeploymentLog, fetchRepoUrl };

function kindOf(target: ProviderTarget): DokployKind {
    return target.kind === 'compose' ? 'compose' : 'application';
}

/** L'instance d'un accès : sans adresse, rien n'est adressable chez Dokploy. */
function instanceOf(access: ProviderAccess): DokployInstance {
    if (!access.baseUrl) throw new ProviderError('Cet accès Dokploy n’a pas d’adresse d’instance.', 0);
    return { baseUrl: access.baseUrl, apiKey: access.secret, relay: access.relay };
}

/** Dokploy derrière le contrat du module, avec ses caches : un catalogue par instance, un dépôt par cible. */
export class DokployProvider implements DeployProviderAdapter {
    readonly id = 'dokploy' as const;
    readonly kinds = ['application', 'compose'] as const;

    private readonly places = new Map<number, { at: number; targets: DokployTarget[] }>();
    /** Le catalogue en cours de lecture, par accès : plusieurs messages le réclament au même tour. */
    private readonly placeLoads = new Map<number, Promise<DokployTarget[]>>();
    /**
     * Le dépôt d'une cible, par accès et identifiant externe. Seule l'adresse
     * est retenue : la fiche qui la porte contient aussi les identifiants du
     * fournisseur Git.
     */
    private readonly repos = new Map<string, { at: number; url: string | null }>();

    constructor(private readonly client: DokployClient = NETWORK) {}

    location(access: Pick<ProviderAccess, 'baseUrl'>): string | null {
        if (!access.baseUrl) return null;
        try {
            return new URL(access.baseUrl).host;
        } catch {
            return access.baseUrl;
        }
    }

    async candidates(access: ProviderAccess): Promise<DeployCandidate[]> {
        const targets = await this.client.listTargets(instanceOf(access));
        return targets.map((t) => ({ kind: t.kind, externalId: t.externalId, name: t.name, path: t.path, ref: null }));
    }

    async trigger(
        access: ProviderAccess,
        target: ProviderTarget,
        input: { title: string; description: string }
    ): Promise<void> {
        await this.client.triggerDeploy(
            instanceOf(access),
            kindOf(target),
            target.externalId,
            input.title,
            input.description
        );
    }

    async history(
        access: ProviderAccess,
        target: ProviderTarget,
        options: ReadOptions = {}
    ): Promise<RemoteDeployment[]> {
        const instance = instanceOf(access);
        const rows = await this.client.listDeployments(instance, kindOf(target), target.externalId, options);
        return rows.map((row) => ({ ...row, url: instance.baseUrl }));
    }

    async noticeLog(
        access: ProviderAccess,
        _target: ProviderTarget,
        entry: RemoteDeployment,
        options: ReadOptions = {}
    ): Promise<string> {
        if (!entry.logRef) return '';
        return this.client.fetchDeploymentLog(instanceOf(access), entry.logRef, options);
    }

    async fullLog(access: ProviderAccess, _target: ProviderTarget, entry: RemoteDeployment): Promise<string> {
        if (!entry.logRef) throw new ProviderError('Aucun journal pour ce déploiement.', 404);
        return this.client.fetchDeploymentLog(instanceOf(access), entry.logRef);
    }

    /**
     * Projet, service et environnement, tels que Dokploy les organise, et le
     * lien vers la fiche. Le nom donné à la cible dans DevEye sert de repli :
     * une instance injoignable fait perdre les colonnes, jamais l'identité.
     */
    async place(
        access: ProviderAccess,
        target: ProviderTarget,
        _entry: RemoteDeployment,
        fallbackName: string
    ): Promise<TargetPlace> {
        const found = await this.catalogEntry(access, target.externalId);
        const url = found && access.baseUrl ? dashboardUrl(access.baseUrl, found) : null;
        return {
            fields: [
                { name: '🛠️ Projet', value: found?.projectName ?? 'inconnu' },
                { name: '⚙️ Service', value: found?.name ?? fallbackName },
                { name: '🌍 Environnement', value: found?.environmentName ?? 'inconnu' },
                { name: '📦 Type', value: kindOf(target) }
            ],
            link: url ? { name: '🔗 Dokploy', label: 'Ouvrir la fiche du service', url } : null
        };
    }

    /**
     * Le dépôt, mémoïsé {@link REPO_TTL_SECONDS}. Le résultat vide compte comme
     * une réponse : une cible sur une image Docker n'a pas de dépôt, et
     * redemander à chaque battement coûterait un appel toutes les dix secondes
     * pour rien. Une instance qui ne répond pas ne laisse rien en cache : c'est
     * le message qui perd son lien, pas la cible.
     */
    async repoUrl(access: ProviderAccess, target: ProviderTarget): Promise<string | null> {
        const key = `${access.credentialId}:${target.externalId}`;
        const now = Math.floor(Date.now() / 1000);
        const cached = this.repos.get(key);
        if (cached && now - cached.at <= REPO_TTL_SECONDS) return cached.url;
        try {
            const url = await this.client.fetchRepoUrl(instanceOf(access), kindOf(target), target.externalId, {
                timeoutMs: BACKGROUND_TIMEOUT_MS
            });
            this.repos.set(key, { at: now, url });
            return url;
        } catch {
            return cached?.url ?? null;
        }
    }

    /**
     * Une cible dans le catalogue de son instance, mémoïsé {@link PLACE_TTL_SECONDS}
     * pour tout l'accès. `null` si l'instance ne répond pas et que rien n'est en
     * cache, ou si elle ne connaît plus la cible.
     */
    private async catalogEntry(access: ProviderAccess, externalId: string): Promise<DokployTarget | null> {
        const now = Math.floor(Date.now() / 1000);
        let cached = this.places.get(access.credentialId);
        if (!cached || now - cached.at > PLACE_TTL_SECONDS) {
            let load = this.placeLoads.get(access.credentialId);
            if (!load) {
                load = this.client
                    .listTargets(instanceOf(access), { timeoutMs: BACKGROUND_TIMEOUT_MS })
                    .finally(() => this.placeLoads.delete(access.credentialId));
                this.placeLoads.set(access.credentialId, load);
            }
            try {
                cached = { at: now, targets: await load };
                this.places.set(access.credentialId, cached);
            } catch {
                // Le catalogue périmé vaut mieux que rien : les noms de projet
                // ne bougent pas.
                if (!cached) return null;
            }
        }
        return cached.targets.find((t) => t.externalId === externalId) ?? null;
    }
}
