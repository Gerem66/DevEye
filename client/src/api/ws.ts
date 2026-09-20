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
} from '@deveye/types';
import { getActiveWorkspaceId } from '../stores/workspace';
import { traceCall } from '../diagnostics/trace';
import { notifyQuotaExceeded } from '@/stores/quotaPrompt';

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

/** Au-delà, la socket est en retard : une trame `post` n'est pas assez importante. */
const POST_BACKPRESSURE_BYTES = 64 * 1024;

export class DevEyeWs {
    private socket: WebSocket | null = null;
    private _state: ConnectionState = 'idle';
    private readonly pending = new Map<string, Pending>();
    private readonly listeners = new Set<EventListener>();
    private readonly stateListeners = new Set<(s: ConnectionState) => void>();
    private reconnectAttempt = 0;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private intentionallyClosed = false;
    private _hasConnected = false;
    private readonly unauthorizedListeners = new Set<() => void>();
    /**
     * Commandes émises avant l'ouverture de la socket. Un composant monté au
     * premier rendu émet la sienne avant la fin de la poignée de main, et la
     * rejeter donnerait un échec que l'appelant ne peut pas distinguer d'un refus
     * métier.
     */
    private outbox: (() => void)[] = [];

    constructor() {
        // Auto-retry when the user comes back to the tab: a connection dropped
        // while it was hidden comes back on its own, with no click needed.
        if (typeof window !== 'undefined') {
            window.addEventListener('focus', this.handleWake);
            document.addEventListener('visibilitychange', this.handleWake);
        }
    }

    get state(): ConnectionState {
        return this._state;
    }

    /** True once the socket has opened at least once, so the UI can tell a genuine
     *  drop apart from the first connect, where no banner should flash. */
    get hasConnected(): boolean {
        return this._hasConnected;
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
        if (s === 'open') {
            // Vidé avant de notifier : un écouteur d'état qui émettrait une
            // commande doit la voir partir après celles qui attendaient déjà.
            const queued = this.outbox;
            this.outbox = [];
            for (const post of queued) post();
        }
        for (const fn of this.stateListeners) fn(s);
    }

    connect(): Promise<void> {
        if (this.socket && (this._state === 'open' || this._state === 'connecting')) {
            return Promise.resolve();
        }
        // A manual/awaited connect supersedes any pending backoff retry.
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        this.intentionallyClosed = false;
        this.setState('connecting');
        return new Promise((resolve, reject) => {
            const ws = new WebSocket(wsUrl());
            this.socket = ws;

            ws.addEventListener('open', () => {
                this._hasConnected = true;
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
                    this._hasConnected = false;
                    for (const fn of this.unauthorizedListeners) fn();
                    return;
                }
                if (!this.intentionallyClosed) this.scheduleReconnect();
            });
        });
    }

    close(): void {
        this.intentionallyClosed = true;
        // Forget this session: the next login is a fresh first connect, so the
        // topbar mustn't flash "Reconnexion…" while it opens.
        this._hasConnected = false;
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        this.socket?.close();
        this.socket = null;
        this.setState('closed');
    }

    /**
     * Force an immediate reconnection: cancels any pending backoff delay and resets
     * the attempt counter, so the socket comes back at once. Safe to call when
     * already open, `connect`'s guard making it a no-op.
     */
    reconnect(): Promise<void> {
        this.reconnectAttempt = 0;
        return this.connect();
    }

    private scheduleReconnect(): void {
        this.reconnectAttempt += 1;
        const delay = Math.min(30_000, 500 * 2 ** this.reconnectAttempt);
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            if (!this.intentionallyClosed) void this.connect().catch(() => {});
        }, delay);
    }

    /** Reconnect on tab focus / visibility regain, but only when the socket was
     *  actually lost: never before the first login (idle), nor after an intentional
     *  close (logout, unauthorized). */
    private handleWake = (): void => {
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
        if (this.intentionallyClosed) return;
        if (this._state === 'closed' || this._state === 'error') {
            void this.reconnect().catch(() => {});
        }
    };

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
                else {
                    if (msg.payload.error.code === 'quota_exceeded') notifyQuotaExceeded(msg.payload.error.message);
                    pending.reject(
                        new WsError(msg.payload.error.code, msg.payload.error.message, msg.payload.error.details)
                    );
                }
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
        // Ces requêtes viennent d'être rejetées : les garder ne servirait qu'à
        // poster, à la reconnexion, des messages sans destinataire.
        this.outbox = [];
    }

    private nextRequestId(): string {
        return crypto.randomUUID();
    }

    /**
     * Poste une trame sans attendre de réponse, et sans file d'attente à l'inverse
     * de {@link send} : une trame émise avant l'ouverture décrit un état déjà
     * périmé, typiquement une position de curseur, et se laisse tomber.
     *
     * Le garde de contre-pression n'est pas facultatif : les métriques
     * (`metrics.push`) partagent ce tampon d'envoi, et sous rafale une trame de
     * curseur s'empilerait derrière elles pour arriver hors sujet.
     */
    post(command: string, payload: unknown): void {
        if (this._state !== 'open' || !this.socket) return;
        if (this.socket.bufferedAmount > POST_BACKPRESSURE_BYTES) return;
        const workspaceId = getActiveWorkspaceId();
        const envelope: ClientMessage = {
            // `requestId` est obligatoire dans l'enveloppe mais n'est jamais lu
            // pour ces trames : le serveur ne répond pas.
            requestId: '-',
            command,
            ...(workspaceId !== null ? { workspaceId } : {}),
            payload
        };
        this.socket.send(JSON.stringify(envelope));
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
        const requestId = this.nextRequestId();
        const startedAt = Date.now();
        const call = new Promise<CommandOutput<N>>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(requestId);
                reject(new WsError('timeout', `Request ${command} timed out`));
            }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
            this.pending.set(requestId, {
                resolve: (value) => resolve(value as CommandOutput<N>),
                reject,
                timer
            });

            const post = (): void => {
                // Le délai a pu expirer, ou une fermeture purger les requêtes en
                // vol, pendant que la socket s'ouvrait.
                if (!this.pending.has(requestId)) return;
                if (!this.socket || this._state !== 'open') {
                    this.pending.delete(requestId);
                    clearTimeout(timer);
                    reject(new WsError('closed', 'WS not open'));
                    return;
                }
                // L'espace actif voyage sur l'enveloppe, jamais dans le payload :
                // aucun site d'appel n'a à le passer, et le serveur n'a qu'un point
                // de résolution ; absent, il retombe sur l'espace personnel. Lu ici
                // et non à l'appel, la session pouvant l'avoir fixé entretemps.
                const workspaceId = getActiveWorkspaceId();
                const envelope: ClientMessage = {
                    requestId,
                    command,
                    ...(workspaceId !== null ? { workspaceId } : {}),
                    payload: parsedInput.data
                };
                const clientParsed = clientMessageSchema.safeParse(envelope);
                if (!clientParsed.success) {
                    this.pending.delete(requestId);
                    clearTimeout(timer);
                    reject(new WsError('protocol', 'Failed to encode envelope'));
                    return;
                }
                this.socket.send(JSON.stringify(clientParsed.data));
            };

            if (this._state === 'open') post();
            else this.outbox.push(post);
        });

        // Toutes les commandes passent ici : c'est le seul endroit où un
        // signalement de bug peut apprendre ce qui a précédé. Le nom de la
        // commande et son issue, jamais l'entrée ni la réponse.
        return traceCall('ws', command, startedAt, call);
    }
}

export const ws = new DevEyeWs();
