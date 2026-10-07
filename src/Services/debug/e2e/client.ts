import { randomUUID } from 'node:crypto';
import type { ErrorCode } from '@deveye/types';
import { FeatureError } from '@deveye/types/sdk/server';
import { request, WebSocket } from 'undici';

import { RUN_HEADER } from './gate';

const HTTP_TIMEOUT_MS = 15_000;
const COMMAND_TIMEOUT_MS = 20_000;

export interface HttpReply {
    status: number;
    body: string;
}

interface Pending {
    resolve(data: unknown): void;
    reject(error: Error): void;
    timer: ReturnType<typeof setTimeout>;
}

type Envelope = {
    requestId?: string;
    command: string;
    payload: { ok: true; data: unknown } | { ok: false; error: { code: string; message: string } };
};

/**
 * Un navigateur sans navigateur : HTTP et socket vers ce serveur même, un pot
 * à cookies comme en a une page, et le jeton de l'essai sur chaque requête.
 * `host` est l'hôte que montre une page de l'app : les pages publiques ne
 * répondent qu'aux hôtes qu'elles servent, jamais à 127.0.0.1.
 */
export function createTestClient({
    base,
    host,
    runToken,
    signal
}: {
    base: string;
    host: string;
    runToken: string;
    signal: AbortSignal;
}) {
    const jar = new Map<string, string>();
    const pending = new Map<string, Pending>();
    let socket: WebSocket | null = null;

    const cookieHeader = (): string => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');

    const absorb = (setCookie: string): void => {
        const [pair, ...attributes] = setCookie.split(';');
        const eq = pair.indexOf('=');
        if (eq <= 0) return;
        const name = pair.slice(0, eq).trim();
        const value = pair.slice(eq + 1).trim();
        const expired = attributes.some((a) => {
            const [k, v = ''] = a.trim().split('=');
            if (k.toLowerCase() === 'max-age') return Number(v) <= 0;
            if (k.toLowerCase() === 'expires') return Date.parse(v) <= Date.now();
            return false;
        });
        if (expired || value === '') jar.delete(name);
        else jar.set(name, value);
    };

    const failAll = (reason: string): void => {
        for (const [id, p] of pending) {
            clearTimeout(p.timer);
            p.reject(new Error(reason));
            pending.delete(id);
        }
    };

    const client = {
        async http(
            path: string,
            init: { method?: 'GET' | 'POST'; body?: unknown; headers?: Record<string, string> } = {}
        ): Promise<HttpReply> {
            const headers: Record<string, string> = { host, [RUN_HEADER]: runToken, ...init.headers };
            if (jar.size > 0) headers.cookie = cookieHeader();
            let body: string | undefined;
            if (init.body !== undefined) {
                body = typeof init.body === 'string' ? init.body : JSON.stringify(init.body);
                headers['content-type'] ??= 'application/json';
            }
            // `request` plutôt que `fetch`, qui remplace l'en-tête Host par celui de l'adresse ; il ne suit pas les redirections.
            const response = await request(`${base}${path}`, {
                method: init.method ?? (body === undefined ? 'GET' : 'POST'),
                headers,
                body,
                signal: AbortSignal.any([signal, AbortSignal.timeout(HTTP_TIMEOUT_MS)])
            });
            for (const c of [response.headers['set-cookie'] ?? []].flat()) absorb(c);
            return { status: response.statusCode, body: await response.body.text() };
        },

        /** Une route de l'API : ses données, ou le refus du serveur en `FeatureError`. */
        async api<T>(path: string, body?: unknown): Promise<T> {
            const reply = await client.http(path, body === undefined ? {} : { method: 'POST', body });
            let parsed: { ok?: boolean; data?: unknown; error?: { code: string; message: string } };
            try {
                parsed = JSON.parse(reply.body);
            } catch {
                throw new Error(`${path} : HTTP ${reply.status}, réponse illisible`);
            }
            if (parsed.ok === true) return parsed.data as T;
            throw new FeatureError(
                (parsed.error?.code ?? 'internal') as ErrorCode,
                `${path} : ${parsed.error?.message ?? `HTTP ${reply.status}`}`
            );
        },

        /** La socket d'une page connectée, avec les cookies du pot. Résout au cadre de session. */
        connect(): Promise<void> {
            client.close();
            return new Promise((resolve, reject) => {
                const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/ws`, {
                    headers: { cookie: cookieHeader(), [RUN_HEADER]: runToken }
                });
                socket = ws;
                let opened = false;
                const timer = setTimeout(() => reject(new Error('Socket : pas de cadre de session')), HTTP_TIMEOUT_MS);
                ws.addEventListener('message', (event) => {
                    let msg: Envelope;
                    try {
                        msg = JSON.parse(String(event.data));
                    } catch {
                        return;
                    }
                    if (!opened && msg.command === 'session') {
                        opened = true;
                        clearTimeout(timer);
                        if (msg.payload.ok) resolve();
                        else reject(new Error(`Socket refusée : ${msg.payload.error.message}`));
                        return;
                    }
                    const waiting = msg.requestId ? pending.get(msg.requestId) : undefined;
                    if (!waiting || !msg.requestId) return;
                    pending.delete(msg.requestId);
                    clearTimeout(waiting.timer);
                    if (msg.payload.ok) waiting.resolve(msg.payload.data);
                    else
                        waiting.reject(
                            new FeatureError(
                                msg.payload.error.code as ErrorCode,
                                `${msg.command} : ${msg.payload.error.message}`
                            )
                        );
                });
                ws.addEventListener('close', () => {
                    clearTimeout(timer);
                    if (!opened) reject(new Error('Socket fermée avant la session'));
                    failAll('Socket fermée');
                });
                ws.addEventListener('error', () => {
                    if (!opened) reject(new Error('Socket injoignable'));
                });
            });
        },

        /** Une commande par la socket et tout le dispatcheur ; rejette en `FeatureError` avec le code du serveur. */
        send<T = unknown>(command: string, input: unknown, opts: { workspaceId?: number } = {}): Promise<T> {
            const ws = socket;
            if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Socket non connectée'));
            const requestId = randomUUID();
            return new Promise<T>((resolve, reject) => {
                const timer = setTimeout(() => {
                    pending.delete(requestId);
                    reject(new Error(`${command} : pas de réponse en ${COMMAND_TIMEOUT_MS / 1000} s`));
                }, COMMAND_TIMEOUT_MS);
                pending.set(requestId, { resolve: (d) => resolve(d as T), reject, timer });
                ws.send(
                    JSON.stringify({
                        requestId,
                        command,
                        payload: input,
                        ...(opts.workspaceId !== undefined ? { workspaceId: opts.workspaceId } : {})
                    })
                );
            });
        },

        close(): void {
            failAll('Socket fermée');
            if (socket && socket.readyState <= WebSocket.OPEN) socket.close();
            socket = null;
        },

        /** Oublie la session : ce que fait une page qui se déconnecte. */
        forgetCookies(): void {
            jar.clear();
        }
    };
    return client;
}

export type TestClient = ReturnType<typeof createTestClient>;
