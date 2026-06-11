import {
    clientMessageSchema,
    featureCommandRegistry,
    serverMessageSchema,
    type ClientMessage,
    type CommandInput,
    type CommandOutput,
    type ConnectionState,
    type ErrorCode,
    type FeatureCommandName,
    type ServerMessage
} from 'deveye-types';

const BASE_URL: string = (import.meta.env.VITE_SERVER_URL as string | undefined) ?? '';

function wsUrl(): string {
    const base = BASE_URL || window.location.origin;
    const url = new URL(base);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.pathname = '/ws';
    return url.toString();
}

export class WsError extends Error {
    constructor(
        public readonly code: ErrorCode | 'closed' | 'timeout' | 'protocol',
        message: string,
        public readonly details?: unknown
    ) {
        super(message);
        this.name = 'WsError';
    }
}

type Pending = {
    resolve: (value: unknown) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
};

type EventListener = (msg: ServerMessage) => void;

const DEFAULT_TIMEOUT_MS = 15_000;

export class DevEyeWs {
    private socket: WebSocket | null = null;
    private _state: ConnectionState = 'idle';
    private readonly pending = new Map<string, Pending>();
    private readonly listeners = new Set<EventListener>();
    private readonly stateListeners = new Set<(s: ConnectionState) => void>();
    private reconnectAttempt = 0;
    private intentionallyClosed = false;
    private readonly unauthorizedListeners = new Set<() => void>();

    get state(): ConnectionState {
        return this._state;
    }

    onMessage(fn: EventListener): () => void {
        this.listeners.add(fn);
        return () => this.listeners.delete(fn);
    }

    onStateChange(fn: (s: ConnectionState) => void): () => void {
        this.stateListeners.add(fn);
        return () => this.stateListeners.delete(fn);
    }

    onUnauthorized(fn: () => void): () => void {
        this.unauthorizedListeners.add(fn);
        return () => this.unauthorizedListeners.delete(fn);
    }

    private setState(s: ConnectionState): void {
        this._state = s;
        for (const fn of this.stateListeners) fn(s);
    }

    connect(): Promise<void> {
        if (this.socket && (this._state === 'open' || this._state === 'connecting')) {
            return Promise.resolve();
        }
        this.intentionallyClosed = false;
        this.setState('connecting');
        return new Promise((resolve, reject) => {
            const ws = new WebSocket(wsUrl());
            this.socket = ws;

            ws.addEventListener('open', () => {
                this.setState('open');
                resolve();
            });

            ws.addEventListener('message', (ev) => this.handleRawMessage(ev.data));

            ws.addEventListener('error', () => {
                if (this._state === 'connecting') reject(new WsError('protocol', 'WS connection failed'));
            });

            ws.addEventListener('close', (ev) => {
                this.setState('closed');
                this.failAllPending(new WsError('closed', `WS closed (${ev.code})`));
                if (ev.code === 4401) {
                    this.intentionallyClosed = true;
                    for (const fn of this.unauthorizedListeners) fn();
                    return;
                }
                if (!this.intentionallyClosed) this.scheduleReconnect();
            });
        });
    }

    close(): void {
        this.intentionallyClosed = true;
        this.socket?.close();
        this.socket = null;
        this.setState('closed');
    }

    private scheduleReconnect(): void {
        this.reconnectAttempt += 1;
        const delay = Math.min(30_000, 500 * 2 ** this.reconnectAttempt);
        setTimeout(() => {
            if (!this.intentionallyClosed) void this.connect().catch(() => {});
        }, delay);
    }

    private handleRawMessage(raw: unknown): void {
        let data: unknown;
        try {
            data = typeof raw === 'string' ? JSON.parse(raw) : raw;
        } catch {
            return;
        }
        const parsed = serverMessageSchema.safeParse(data);
        if (!parsed.success) return;
        const msg = parsed.data;

        if (msg.command === 'session' && msg.payload.ok) {
            this.reconnectAttempt = 0;
        }

        if (msg.requestId) {
            const pending = this.pending.get(msg.requestId);
            if (pending) {
                clearTimeout(pending.timer);
                this.pending.delete(msg.requestId);
                if (msg.payload.ok) pending.resolve(msg.payload.data);
                else
                    pending.reject(
                        new WsError(msg.payload.error.code, msg.payload.error.message, msg.payload.error.details)
                    );
                return;
            }
        }
        for (const fn of this.listeners) fn(msg);
    }

    private failAllPending(err: Error): void {
        for (const [, p] of this.pending) {
            clearTimeout(p.timer);
            p.reject(err);
        }
        this.pending.clear();
    }

    private nextRequestId(): string {
        return crypto.randomUUID();
    }

    /**
     * Send a feature command and await its typed response.
     * Validates input against the descriptor schema before sending.
     */
    send<N extends FeatureCommandName>(
        command: N,
        input: CommandInput<N>,
        opts: { timeoutMs?: number } = {}
    ): Promise<CommandOutput<N>> {
        const descriptor = featureCommandRegistry[command];
        if (!descriptor) return Promise.reject(new WsError('protocol', `Unknown command: ${command}`));
        const parsedInput = descriptor.input.safeParse(input);
        if (!parsedInput.success) {
            return Promise.reject(new WsError('protocol', 'Invalid input', parsedInput.error.flatten()));
        }
        if (!this.socket || this._state !== 'open') {
            return Promise.reject(new WsError('closed', 'WS not open'));
        }
        const requestId = this.nextRequestId();
        const envelope: ClientMessage = {
            requestId,
            command,
            payload: parsedInput.data
        };
        const clientParsed = clientMessageSchema.safeParse(envelope);
        if (!clientParsed.success) {
            return Promise.reject(new WsError('protocol', 'Failed to encode envelope'));
        }
        return new Promise<CommandOutput<N>>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(requestId);
                reject(new WsError('timeout', `Request ${command} timed out`));
            }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
            this.pending.set(requestId, {
                resolve: (value) => resolve(value as CommandOutput<N>),
                reject,
                timer
            });
            this.socket!.send(JSON.stringify(clientParsed.data));
        });
    }
}

export const ws = new DevEyeWs();
