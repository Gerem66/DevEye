import type { AppStore, AppStoresReplyState } from '../../contracts/domain';

/**
 * Ce que les clients d'Apple et de Google partagent : le transport, l'erreur
 * qu'ils lèvent, et la forme commune d'un avis. Les hôtes sont fixes et écrits
 * en dur : rien de ce que saisit l'utilisateur n'entre dans un nom d'hôte.
 */

/** Un store qui se tait ne retient pas une passe plus longtemps. */
export const STORE_TIMEOUT_MS = 20_000;

/** Ce qu'on lit d'une réponse d'erreur, pour le journal seulement. */
const ERROR_DETAIL_MAX = 300;

export type StoreFetch = (url: string, init: RequestInit) => Promise<Response>;

/** Le transport des clients : un test le remplace, jamais le code du module. */
export const storeHttp: { fetch: StoreFetch } = { fetch: (url, init) => fetch(url, init) };

const STORE_NAME: Record<AppStore, string> = { apple: 'Apple', google: 'Google' };

/** La phrase que l'écran montre pour un statut : la nôtre, jamais celle du store. */
function sentenceFor(store: AppStore, status: number): string {
    const who = STORE_NAME[store];
    if (status === 0) return `${who} ne répond pas.`;
    if (status === 401) return `${who} refuse la clé : elle a pu être révoquée ou mal recopiée.`;
    if (status === 403) return `${who} refuse l’accès : la clé n’a pas le rôle nécessaire.`;
    if (status === 404) return `${who} ne trouve pas ce qui est demandé.`;
    if (status === 429) return `${who} limite les appels de cette clé : nouvel essai dans quelques minutes.`;
    if (status >= 500) return `${who} est en panne (erreur ${status}).`;
    return `${who} a refusé la requête (erreur ${status}).`;
}

/**
 * Un échec d'appel à un store. `message` est une phrase écrite ici ; `detail`
 * garde ce que le store a répondu, pour le journal et jamais pour l'écran.
 */
export class StoreError extends Error {
    readonly retryAt: number | null;
    readonly detail: string | null;

    constructor(
        readonly store: AppStore,
        /** Le statut HTTP, 0 sans réponse. */
        readonly status: number,
        options: { message?: string; retryAt?: number | null; detail?: string | null; cause?: unknown } = {}
    ) {
        super(options.message ?? sentenceFor(store, status));
        this.name = 'StoreError';
        this.retryAt = options.retryAt ?? null;
        this.detail = options.detail ?? null;
        if (options.cause !== undefined) this.cause = options.cause;
    }

    /** La clé est refusée, ou n'ouvre pas ce qu'on lui demande. */
    get refused(): boolean {
        return this.status === 401 || this.status === 403;
    }

    get rateLimited(): boolean {
        return this.status === 429;
    }
}

/** Un arrêt demandé par le service, à distinguer d'une panne. */
export function isAbort(error: unknown): boolean {
    return error instanceof Error && error.name === 'AbortError';
}

/** `Retry-After` en secondes epoch : un délai en secondes, ou une date HTTP. */
export function retryAtOf(header: string | null, nowMs: number = Date.now()): number | null {
    if (!header) return null;
    const seconds = Number(header.trim());
    if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(nowMs / 1000 + seconds);
    const at = Date.parse(header);
    return Number.isNaN(at) ? null : Math.ceil(at / 1000);
}

/**
 * Un appel à un store : l'agent `DevEye`, le délai, l'arrêt du service. Rend
 * la réponse quand elle est un succès ; lève une {@link StoreError} sinon, ou
 * l'`AbortError` d'un arrêt demandé.
 */
export async function storeCall(
    store: AppStore,
    url: string,
    init: RequestInit & { signal?: AbortSignal },
    expected: readonly number[] = []
): Promise<Response> {
    const timeout = AbortSignal.timeout(STORE_TIMEOUT_MS);
    const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    let res: Response;
    try {
        res = await storeHttp.fetch(url, {
            ...init,
            headers: { 'User-Agent': 'DevEye', ...(init.headers as Record<string, string> | undefined) },
            signal
        });
    } catch (e) {
        if (init.signal?.aborted) throw e;
        throw new StoreError(store, 0, { cause: e });
    }
    if (res.ok || expected.includes(res.status)) return res;
    const detail = (await res.text().catch(() => '')).slice(0, ERROR_DETAIL_MAX).trim();
    throw new StoreError(store, res.status, {
        retryAt: retryAtOf(res.headers.get('retry-after')),
        detail: detail || null
    });
}

/**
 * Le corps d'une réponse, coupé au-delà de `maxBytes` : un rapport démesuré
 * ne doit pas remplir la mémoire du serveur.
 */
export async function readBody(store: AppStore, res: Response, maxBytes: number): Promise<Buffer> {
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) {
        throw new StoreError(store, res.status, { message: 'Le rapport du store est trop volumineux pour être lu.' });
    }
    if (!res.body) return Buffer.alloc(0);
    const parts: Buffer[] = [];
    let size = 0;
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        size += chunk.byteLength;
        if (size > maxBytes) {
            throw new StoreError(store, res.status, {
                message: 'Le rapport du store est trop volumineux pour être lu.'
            });
        }
        parts.push(Buffer.from(chunk));
    }
    return Buffer.concat(parts);
}

/** Un JSON de store, ou une erreur qui dit qu'il ne se lit pas. */
export async function readStoreJson<T>(store: AppStore, res: Response): Promise<T> {
    const text = await res.text();
    try {
        return JSON.parse(text) as T;
    } catch (e) {
        throw new StoreError(store, res.status, {
            message: `${STORE_NAME[store]} a rendu une réponse illisible.`,
            detail: text.slice(0, ERROR_DETAIL_MAX),
            cause: e
        });
    }
}

/** Un avis tel qu'un store le décrit, ramené à une forme commune. */
export interface StoreReview {
    /** L'identifiant de l'avis chez le store. */
    externalId: string;
    rating: number;
    title: string;
    body: string;
    author: string;
    territory: string | null;
    appVersion: string | null;
    /** Secondes epoch. */
    createdAt: number;
    reply: StoreReply | null;
}

export interface StoreReply {
    body: string;
    at: number | null;
    state: AppStoresReplyState;
    /** Apple seulement : la réponse se supprime par son identifiant avant d'être remplacée. */
    responseId: string | null;
}

/** Une app que la clé voit chez son store. */
export interface StoreApp {
    externalId: string;
    name: string;
    bundleId: string | null;
}

/** Une note relevée un jour, telle qu'un store la donne. */
export interface StoreRating {
    rating: number;
    count: number | null;
}
