import {
    changePasswordRequestSchema,
    changePasswordResponseSchema,
    loginRequestSchema,
    loginResponseSchema,
    meResponseSchema,
    refreshResponseSchema,
    resultSchema,
    type ChangePasswordRequest,
    type ChangePasswordResponse,
    type ErrorCode,
    type LoginRequest,
    type LoginResponse,
    type MeResponse,
    type RefreshResponse,
    type SessionTokens
} from '@deveye/types';
import { z } from 'zod';
import { getActiveInstanceId, getActiveWorkspaceId } from '@/stores/workspace';
import { traceCall } from '@/diagnostics/trace';

const BASE_URL: string = (import.meta.env.VITE_SERVER_URL as string | undefined) ?? '';

export class ApiError extends Error {
    constructor(
        public readonly code: ErrorCode | 'network' | 'unknown',
        message: string,
        public readonly status?: number,
        public readonly details?: unknown
    ) {
        super(message);
        this.name = 'ApiError';
    }
}

/**
 * Une instance distante, vue d'une requête. Celle-ci s'authentifie par ses
 * cookies ; là-bas ils n'existent pas pour nous, le jeton voyage en en-tête.
 */
export interface HttpTarget {
    origin: string;
    /** Un jeton d'accès encore valable, renouvelé s'il touche à sa fin. */
    fresh(): Promise<string>;
    /** Force le renouvellement ; rejette quand la session de là-bas n'existe plus. */
    renew(): Promise<string>;
    /** Les jetons qu'une réponse vient de remplacer (changement de mot de passe). */
    adopt(tokens: SessionTokens): void;
}

/**
 * Qui sait trouver l'instance de l'espace actif (`stores/remoteInstances`, qui
 * dépend de ce fichier et s'inscrit donc ici). `null` : cette instance.
 */
let resolveTarget: (instanceId: number) => HttpTarget = () => {
    throw new ApiError('auth_required', 'Instance distante déconnectée');
};

export function setHttpTargetResolver(fn: (instanceId: number) => HttpTarget): void {
    resolveTarget = fn;
}

function activeTarget(): HttpTarget | null {
    const instanceId = getActiveInstanceId();
    return instanceId === null ? null : resolveTarget(instanceId);
}

/**
 * Routes d'authentification : elles ne doivent JAMAIS déclencher le
 * rafraîchissement automatique ci-dessous, sous peine de boucle (un `/refresh`
 * expiré relancerait un `/refresh`).
 */
const AUTH_PATHS = ['/api/auth/refresh', '/api/auth/login', '/api/auth/me', '/api/auth/logout'];

/** Le jeton d'accès a expiré ou manque : les deux se rattrapent par un refresh. */
const isExpiredCode = (code: string): boolean => code === 'auth_expired' || code === 'auth_required';

/** Rafraîchissement en vol, partagé : plusieurs 401 simultanés n'en valent qu'un. */
let refreshing: Promise<void> | null = null;

/**
 * Renouvelle le cookie d'accès, au plus une fois à la fois. Le cookie `dv_at` ne
 * vit que `JWT_ACCESS_TTL_SECONDS` alors que la WebSocket reste ouverte des
 * heures : sans ce rappel, un onglet posé sur une socket saine ne repasse jamais
 * par l'authentification HTTP et toute requête REST finit en 401.
 */
function ensureLocalAccess(): Promise<void> {
    refreshing ??= (async () => {
        try {
            // Même query d'espace que `refresh()` : sans elle le serveur recalcule
            // l'espace actif et peut renvoyer les droits d'un autre.
            await request(`/api/auth/refresh${workspaceQuery()}`, { method: 'POST' }, refreshResponseSchema, null);
        } finally {
            refreshing = null;
        }
    })();
    return refreshing;
}

/**
 * Consigne l'appel pour un éventuel signalement de bug, puis le laisse suivre
 * son cours. Le rejeu d'un jeton périmé n'y figure pas deux fois : il repasse
 * par `runRequest`, et le rafraîchissement qui l'a provoqué a sa propre ligne.
 */
function request<TOut>(
    path: string,
    init: RequestInit,
    outputSchema: z.ZodType<TOut>,
    /** `null` : cette instance, quel que soit l'espace actif. Omis : l'instance de l'espace actif. */
    target: HttpTarget | null = activeTarget()
): Promise<TOut> {
    const label = `${init.method ?? 'GET'} ${path.split('?')[0]}`;
    return traceCall('http', label, Date.now(), runRequest(path, init, outputSchema, target));
}

/**
 * Une requête vers une instance distante précise, qu'elle soit active ou non.
 * `anonymous` : avant toute session là-bas (sonde, connexion), sans jeton.
 */
export function requestAt<TOut>(
    target: HttpTarget | { origin: string; anonymous: true },
    path: string,
    init: RequestInit,
    outputSchema: z.ZodType<TOut>
): Promise<TOut> {
    const resolved: HttpTarget =
        'anonymous' in target
            ? {
                  origin: target.origin,
                  fresh: () => Promise.resolve(''),
                  renew: () => Promise.reject(new ApiError('auth_required', 'Aucune session sur cette instance')),
                  adopt: () => {}
              }
            : target;
    return request(path, init, outputSchema, resolved);
}

/** L'appel lui-même : cookies vers cette instance, jeton en en-tête et rien d'autre vers une distante. */
async function send(path: string, init: RequestInit, target: HttpTarget | null): Promise<Response> {
    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...(init.headers as Record<string, string> | undefined)
    };
    if (target === null) return fetch(`${BASE_URL}${path}`, { credentials: 'include', ...init, headers });
    const token = await target.fresh();
    if (token) headers.Authorization = `Bearer ${token}`;
    return fetch(`${target.origin}${path}`, { ...init, credentials: 'omit', headers });
}

async function runRequest<TOut>(
    path: string,
    init: RequestInit,
    outputSchema: z.ZodType<TOut>,
    target: HttpTarget | null,
    /** Interne : empêche le rejeu de se rejouer lui-même. */
    retried = false
): Promise<TOut> {
    let res: Response;
    try {
        res = await send(path, init, target);
    } catch (e) {
        if (e instanceof ApiError) throw e;
        throw new ApiError('network', (e as Error).message);
    }

    const json: unknown = await res.json().catch(() => ({}));
    const envelope = resultSchema(outputSchema).safeParse(json);
    if (!envelope.success) {
        throw new ApiError('unknown', 'Malformed server response', res.status, envelope.error.flatten());
    }
    if (!envelope.data.ok) {
        const { code, message, details } = envelope.data.error;
        // Un jeton d'accès périmé se répare tant que le jeton de rafraîchissement
        // tient : renouveler et rejouer une fois. Un échec laisse remonter l'erreur
        // d'origine, que `AuthProvider` traduira en déconnexion.
        if (isExpiredCode(code) && !retried && !AUTH_PATHS.includes(path.split('?')[0])) {
            try {
                if (target) await target.renew();
                else await ensureLocalAccess();
            } catch (renewal) {
                // Là-bas, une coupure pendant le renouvellement n'est pas une session
                // morte : la confondre ferait oublier une session encore valable.
                if (target && renewal instanceof ApiError && renewal.code === 'network') throw renewal;
                throw new ApiError(code, message, res.status, details);
            }
            return runRequest(path, init, outputSchema, target, true);
        }
        throw new ApiError(code, message, res.status, details);
    }
    return envelope.data.data;
}

export function login(payload: LoginRequest): Promise<LoginResponse> {
    const body = loginRequestSchema.parse(payload);
    return request('/api/auth/login', { method: 'POST', body: JSON.stringify(body) }, loginResponseSchema, null);
}

/**
 * Espace actif transmis en query : sans lui le serveur le recalcule de son côté
 * et renvoie le thème, la disposition et les droits d'un autre espace que celui
 * affiché. Il reste juge de l'accès et ignore un id inaccessible.
 */
function workspaceQuery(): string {
    // Assis dans un espace distant, son id ne dit rien à cette instance.
    const id = getActiveInstanceId() === null ? getActiveWorkspaceId() : null;
    return id === null ? '' : `?workspace=${id}`;
}

export function refresh(): Promise<RefreshResponse> {
    return request(`/api/auth/refresh${workspaceQuery()}`, { method: 'POST' }, refreshResponseSchema, null);
}

export function logout(): Promise<{ loggedOut: true }> {
    return request('/api/auth/logout', { method: 'POST' }, z.object({ loggedOut: z.literal(true) }), null);
}

export function me(): Promise<MeResponse> {
    return request(`/api/auth/me${workspaceQuery()}`, { method: 'GET' }, meResponseSchema, null);
}

/** Le mot de passe du compte qu'on EST : celui de l'instance distante quand on s'y trouve. */
export async function changePassword(payload: ChangePasswordRequest): Promise<ChangePasswordResponse> {
    const body = changePasswordRequestSchema.parse(payload);
    const target = activeTarget();
    const res = await request(
        '/api/auth/change-password',
        { method: 'POST', body: JSON.stringify(body) },
        changePasswordResponseSchema,
        target
    );
    // Les anciens jetons viennent d'être révoqués avec les autres sessions.
    if (target && res.tokens) target.adopt(res.tokens);
    return res;
}

/** `GET` vers cette instance, quel que soit l'espace actif (son état de démarrage, par exemple). */
export function getLocal<T>(path: string, outputSchema: z.ZodType<T>): Promise<T> {
    return request(path, { method: 'GET' }, outputSchema, null);
}

/**
 * Un `fetch` brut vers l'instance de l'espace actif, authentifié comme il se
 * doit là-bas : pour ce qui ne rend pas l'enveloppe JSON habituelle (un binaire
 * à télécharger).
 */
export async function httpFetch(path: string, init: RequestInit = {}): Promise<Response> {
    const target = activeTarget();
    if (target === null) await ensureLocalAccess();
    return send(path, init, target);
}

export function post<T>(
    path: string,
    body: unknown,
    outputSchema: z.ZodType<T> = z.unknown() as z.ZodType<T>
): Promise<T> {
    return request(path, { method: 'POST', body: JSON.stringify(body) }, outputSchema);
}

export function get<T>(
    path: string,
    outputSchema: z.ZodType<T> = z.unknown() as z.ZodType<T>,
    headers?: Record<string, string>
): Promise<T> {
    return request(path, { method: 'GET', headers }, outputSchema);
}

export function del<T>(path: string, outputSchema: z.ZodType<T> = z.unknown() as z.ZodType<T>): Promise<T> {
    return request(path, { method: 'DELETE' }, outputSchema);
}

export function patch<T>(
    path: string,
    body: unknown,
    outputSchema: z.ZodType<T> = z.unknown() as z.ZodType<T>
): Promise<T> {
    return request(path, { method: 'PATCH', body: JSON.stringify(body) }, outputSchema);
}
