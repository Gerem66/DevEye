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
    type RefreshResponse
} from '@deveye/types';
import { z } from 'zod';
import { getActiveWorkspaceId } from '@/stores/workspace';
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
export function ensureFreshAccess(): Promise<void> {
    refreshing ??= (async () => {
        try {
            // Même query d'espace que `refresh()` : sans elle le serveur recalcule
            // l'espace actif et peut renvoyer les droits d'un autre.
            await request(`/api/auth/refresh${workspaceQuery()}`, { method: 'POST' }, refreshResponseSchema);
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
function request<TOut>(path: string, init: RequestInit, outputSchema: z.ZodType<TOut>): Promise<TOut> {
    const target = `${init.method ?? 'GET'} ${path.split('?')[0]}`;
    return traceCall('http', target, Date.now(), runRequest(path, init, outputSchema));
}

async function runRequest<TOut>(
    path: string,
    init: RequestInit,
    outputSchema: z.ZodType<TOut>,
    /** Interne : empêche le rejeu de se rejouer lui-même. */
    retried = false
): Promise<TOut> {
    let res: Response;
    try {
        res = await fetch(`${BASE_URL}${path}`, {
            credentials: 'include',
            ...init,
            headers: { 'Content-Type': 'application/json', ...init.headers }
        });
    } catch (e) {
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
                await ensureFreshAccess();
            } catch {
                throw new ApiError(code, message, res.status, details);
            }
            return runRequest(path, init, outputSchema, true);
        }
        throw new ApiError(code, message, res.status, details);
    }
    return envelope.data.data;
}

export function login(payload: LoginRequest): Promise<LoginResponse> {
    const body = loginRequestSchema.parse(payload);
    return request('/api/auth/login', { method: 'POST', body: JSON.stringify(body) }, loginResponseSchema);
}

/**
 * Espace actif transmis en query : sans lui le serveur le recalcule de son côté
 * et renvoie le thème, la disposition et les droits d'un autre espace que celui
 * affiché. Il reste juge de l'accès et ignore un id inaccessible.
 */
function workspaceQuery(): string {
    const id = getActiveWorkspaceId();
    return id === null ? '' : `?workspace=${id}`;
}

export function refresh(): Promise<RefreshResponse> {
    return request(`/api/auth/refresh${workspaceQuery()}`, { method: 'POST' }, refreshResponseSchema);
}

export function logout(): Promise<{ loggedOut: true }> {
    return request('/api/auth/logout', { method: 'POST' }, z.object({ loggedOut: z.literal(true) }));
}

export function me(): Promise<MeResponse> {
    return request(`/api/auth/me${workspaceQuery()}`, { method: 'GET' }, meResponseSchema);
}

export function changePassword(payload: ChangePasswordRequest): Promise<ChangePasswordResponse> {
    const body = changePasswordRequestSchema.parse(payload);
    return request(
        '/api/auth/change-password',
        { method: 'POST', body: JSON.stringify(body) },
        changePasswordResponseSchema
    );
}

export function post<T>(
    path: string,
    body: unknown,
    outputSchema: z.ZodType<T> = z.unknown() as z.ZodType<T>
): Promise<T> {
    return request(path, { method: 'POST', body: JSON.stringify(body) }, outputSchema);
}

export function get<T>(path: string, outputSchema: z.ZodType<T> = z.unknown() as z.ZodType<T>): Promise<T> {
    return request(path, { method: 'GET' }, outputSchema);
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
