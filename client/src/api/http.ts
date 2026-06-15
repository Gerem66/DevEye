import {
    loginRequestSchema,
    loginResponseSchema,
    meResponseSchema,
    refreshResponseSchema,
    resultSchema,
    type ErrorCode,
    type LoginRequest,
    type LoginResponse,
    type MeResponse,
    type RefreshResponse
} from 'deveye-types';
import { z } from 'zod';

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

async function request<TOut>(path: string, init: RequestInit, outputSchema: z.ZodType<TOut>): Promise<TOut> {
    let res: Response;
    try {
        res = await fetch(`${BASE_URL}${path}`, {
            credentials: 'include',
            headers: { 'Content-Type': 'application/json', ...init.headers },
            ...init
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
        throw new ApiError(code, message, res.status, details);
    }
    return envelope.data.data;
}

export function login(payload: LoginRequest): Promise<LoginResponse> {
    const body = loginRequestSchema.parse(payload);
    return request('/api/auth/login', { method: 'POST', body: JSON.stringify(body) }, loginResponseSchema);
}

export function refresh(): Promise<RefreshResponse> {
    return request('/api/auth/refresh', { method: 'POST' }, refreshResponseSchema);
}

export function logout(): Promise<{ loggedOut: true }> {
    return request('/api/auth/logout', { method: 'POST' }, z.object({ loggedOut: z.literal(true) }));
}

export function me(): Promise<MeResponse> {
    return request('/api/auth/me', { method: 'GET' }, meResponseSchema);
}

export function post<T>(
    path: string,
    body: unknown,
    outputSchema: z.ZodType<T> = z.unknown() as z.ZodType<T>
): Promise<T> {
    return request(path, { method: 'POST', body: JSON.stringify(body) }, outputSchema);
}
