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
 * Renouvelle le cookie d'accès, au plus une fois à la fois.
 *
 * Le cookie `dv_at` ne vit que `JWT_ACCESS_TTL_SECONDS` (quinze minutes par
 * défaut) alors que la WebSocket, elle, reste ouverte des heures. Un onglet posé
 * sur une socket saine ne repassait donc jamais par l'authentification HTTP :
 * passé le quart d'heure, toute requête REST tombait en 401 pendant que le reste
 * de l'application continuait de fonctionner. Le symptôme était incompréhensible
 * — « Télécharger l'agent » indisponible sur un site manifestement connecté.
 */
export function ensureFreshAccess(): Promise<void> {
    refreshing ??= (async () => {
        try {
            // Même query d'espace que `refresh()` : sans elle le serveur
            // recalcule l'espace actif de son côté et peut renvoyer les droits
            // d'un autre espace que celui affiché.
            await request(`/api/auth/refresh${workspaceQuery()}`, { method: 'POST' }, refreshResponseSchema);
        } finally {
            refreshing = null;
        }
    })();
    return refreshing;
}

async function request<TOut>(
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
        // Un jeton d'accès périmé se répare tout seul tant que le jeton de
        // rafraîchissement tient : on renouvelle et on rejoue UNE fois. Un échec
        // du renouvellement laisse remonter l'erreur d'origine, que
        // `AuthProvider` traduira en déconnexion sur le prochain incident.
        if (isExpiredCode(code) && !retried && !AUTH_PATHS.includes(path.split('?')[0])) {
            try {
                await ensureFreshAccess();
            } catch {
                throw new ApiError(code, message, res.status, details);
            }
            return request(path, init, outputSchema, true);
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
 * Espace actif transmis en query.
 *
 * Sans lui, le serveur recalcule l'espace actif de son côté (le favori, sinon le
 * personnel) et renvoie le thème, la disposition **et les droits** d'un autre
 * espace que celui affiché. Il reste juge de l'accès : un id inaccessible est
 * ignoré et il retombe sur un espace valide.
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
