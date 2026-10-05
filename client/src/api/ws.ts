import {
    clientMessageSchema,
    featureCommandRegistry,
    IDLE_CLOSE_CODE,
    MAINTENANCE_CLOSE_CODE,
    MAINTENANCE_EVENT,
    maintenanceStateSchema,
    QUEUE_CLOSE_CODE,
    queueRefusalSchema,
    REQUEST_PROGRESS_EVENT,
    requestProgressSchema,
    serverMessageSchema,
    sessionFrameSchema,
    type ClientMessage,
    type CommandInput,
    type CommandOutput,
    type ConnectionState,
    type ErrorCode,
    type FeatureCommandName,
    type MaintenanceState,
    type RequestProgress,
    type ServerMessage
} from '@deveye/types';
import { getActiveInstanceId, getActiveWorkspaceId, onWorkspaceChange } from '../stores/workspace';
import { traceCall } from '../diagnostics/trace';
import { notifyQuotaExceeded } from '@/stores/quotaPrompt';
import { setAdmission, type Admission } from '@/stores/admission';
import { forgetMaintenance, setMaintenance } from '@/stores/maintenance';
import { randomUuid } from '@/randomUuid';

const BASE_URL: string = (import.meta.env.VITE_SERVER_URL as string | undefined) ?? '';

/** L'adresse de la socket d'une instance, à partir de son origine HTTP. */
export function wsUrlOf(origin: string, ticket?: string): string {
    const url = new URL(origin);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.pathname = '/ws';
    if (ticket) url.searchParams.set('ticket', ticket);
    return url.toString();
}

/**
 * L'instance qu'une socket vise. Celle-ci s'ouvre sur son cookie ; une instance
 * distante sur un ticket, demandé à chaque (re)connexion.
 */
export interface WsTarget {
    /** `null` : cette instance. */
    instanceId: number | null;
    /** Rejette {@link WsUnauthorizedError} quand la session de là-bas n'existe plus. */
    url(): Promise<string>;
}

/** La session visée est morte : inutile de réessayer, il faut se reconnecter. */
export class WsUnauthorizedError extends Error {}

const LOCAL_TARGET: WsTarget = {
    instanceId: null,
    url: () => Promise.resolve(wsUrlOf(BASE_URL || window.location.origin))
};

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
    /** Une trame d'avancement relance le délai : il borne le silence, pas la durée. */
    rearm: () => void;
    onProgress?: (update: ProgressUpdate) => void;
};

export type ProgressUpdate = Omit<RequestProgress, 'requestId'>;

type EventListener = (msg: ServerMessage) => void;

const DEFAULT_TIMEOUT_MS = 15_000;

/** Au-delà, la socket est en retard : une trame `post` n'est pas assez importante. */
const POST_BACKPRESSURE_BYTES = 64 * 1024;

/** Refusée pour maintenance : un essai à ce rythme, pas de rafale contre un serveur qui se défend. */
const MAINTENANCE_RETRY_MS = 60_000;

/** En file d'attente : le serveur oublie qui ne relance pas sa demande dans la minute. */
const QUEUE_RETRY_MS = 15_000;

const RELOADED_FOR_KEY = 'deveye.reloadedFor';

/**
 * Le serveur a changé de version (un déploiement pendant la coupure) : la page
 * recharge pour prendre le bundle qui va avec. Une seule fois par version
 * serveur : un build servi en retard sur le serveur ferait sinon boucler.
 */
function reloadIfOutdated(serverVersion: string): void {
    try {
        if (serverVersion === __APP_VERSION__) {
            sessionStorage.removeItem(RELOADED_FOR_KEY);
            return;
        }
        if (sessionStorage.getItem(RELOADED_FOR_KEY) === serverVersion) return;
        sessionStorage.setItem(RELOADED_FOR_KEY, serverVersion);
    } catch {
        return;
    }
    window.location.reload();
}

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
    private readonly maintenanceListeners = new Set<(state: MaintenanceState) => void>();
    private readonly admissionListeners = new Set<(admission: Admission) => void>();
    private readonly versionListeners = new Set<(version: string) => void>();
    /** Une ouverture en cours : l'adresse d'une instance distante s'obtient avant la socket. */
    private opening: Promise<void> | null = null;
    /** Ce qui attend la trame `session` de la socket en cours d'ouverture. */
    private onSession: (() => void) | null = null;
    /**
     * Commandes émises avant l'ouverture de la socket. Un composant monté au
     * premier rendu émet la sienne avant la fin de la poignée de main, et la
     * rejeter donnerait un échec que l'appelant ne peut pas distinguer d'un refus
     * métier.
     */
    private outbox: (() => void)[] = [];

    constructor(private readonly target: WsTarget = LOCAL_TARGET) {
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

    /** L'état de maintenance du serveur, à l'ouverture puis à chaque changement. */
    onMaintenance(fn: (state: MaintenanceState) => void): () => void {
        this.maintenanceListeners.add(fn);
        return () => this.maintenanceListeners.delete(fn);
    }

    private emitMaintenance(state: MaintenanceState): void {
        for (const fn of this.maintenanceListeners) fn(state);
    }

    /** L'entrée sur ce serveur quand des places simultanées font attendre. */
    onAdmission(fn: (admission: Admission) => void): () => void {
        this.admissionListeners.add(fn);
        return () => this.admissionListeners.delete(fn);
    }

    private emitAdmission(admission: Admission): void {
        for (const fn of this.admissionListeners) fn(admission);
    }

    /** La version du serveur, à chaque ouverture. */
    onServerVersion(fn: (version: string) => void): () => void {
        this.versionListeners.add(fn);
        return () => this.versionListeners.delete(fn);
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
        if (this.socket && this._state === 'open') return Promise.resolve();
        if (this.opening) return this.opening;
        // A manual/awaited connect supersedes any pending backoff retry.
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        this.intentionallyClosed = false;
        this.setState('connecting');
        this.opening = this.target
            .url()
            .then(
                (url) => this.open(url),
                // Sans adresse, pas de socket, donc pas de `close` pour relancer.
                (e: unknown) => {
                    this.setState('closed');
                    if (e instanceof WsUnauthorizedError) this.refuse();
                    else if (!this.intentionallyClosed) this.scheduleReconnect();
                    throw e;
                }
            )
            .finally(() => {
                this.opening = null;
            });
        return this.opening;
    }

    /** La session n'existe plus : on cesse de réessayer, et ceux qui savent la refaire sont prévenus. */
    private refuse(): void {
        this.intentionallyClosed = true;
        this._hasConnected = false;
        for (const fn of this.unauthorizedListeners) fn();
    }

    private open(url: string): Promise<void> {
        return new Promise((resolve, reject) => {
            // Fermée pendant qu'on attendait son adresse (déconnexion).
            if (this.intentionallyClosed) {
                reject(new WsError('closed', 'WS closed before opening'));
                return;
            }
            const ws = new WebSocket(url);
            this.socket = ws;

            // « Ouverte » à la trame `session`, pas à la poignée de main : le
            // serveur n'écoute qu'après avoir vérifié la session en base, et une
            // commande partie avant serait perdue sans réponse. L'écart se voit
            // dès que le serveur est loin (une instance distante derrière un VPN).
            this.onSession = () => {
                this._hasConnected = true;
                this.setState('open');
                resolve();
            };

            ws.addEventListener('message', (ev) => this.handleRawMessage(ev.data));

            ws.addEventListener('error', () => {
                if (this._state === 'connecting') reject(new WsError('protocol', 'WS connection failed'));
            });

            ws.addEventListener('close', (ev) => {
                this.onSession = null;
                // Fermée avant d'avoir servi (session refusée) : `connect()` doit le savoir.
                if (this._state === 'connecting') reject(new WsError('closed', `WS closed (${ev.code})`));
                this.setState('closed');
                this.failAllPending(new WsError('closed', `WS closed (${ev.code})`));
                if (ev.code === 4401) {
                    this.refuse();
                    return;
                }
                if (ev.code === MAINTENANCE_CLOSE_CODE) {
                    this.scheduleReconnect(MAINTENANCE_RETRY_MS);
                    return;
                }
                if (ev.code === QUEUE_CLOSE_CODE) {
                    this.scheduleReconnect(QUEUE_RETRY_MS);
                    return;
                }
                // Sa place est allée à quelqu'un qui attendait : on ne revient
                // qu'avec la personne (retour sur l'onglet, bouton « Reprendre »).
                if (ev.code === IDLE_CLOSE_CODE) {
                    this.emitAdmission({ kind: 'released' });
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

    private scheduleReconnect(fixedDelay?: number): void {
        this.reconnectAttempt += 1;
        const delay = fixedDelay ?? Math.min(30_000, 500 * 2 ** this.reconnectAttempt);
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
            this.emitAdmission(null);
            const frame = sessionFrameSchema.safeParse(msg.payload.data);
            if (frame.success && frame.data.maintenance) this.emitMaintenance(frame.data.maintenance);
            if (frame.success && frame.data.version) {
                for (const fn of this.versionListeners) fn(frame.data.version);
            }
            const ready = this.onSession;
            this.onSession = null;
            ready?.();
        }

        // En file d'attente : la fermeture `QUEUE_CLOSE_CODE` suit.
        if (msg.command === 'session' && !msg.payload.ok && msg.payload.error.code === 'queued') {
            const refusal = queueRefusalSchema.safeParse(msg.payload.error.details);
            if (refusal.success) this.emitAdmission({ kind: 'queued', position: refusal.data.position });
        }

        // Refusée à l'ouverture : la fermeture `MAINTENANCE_CLOSE_CODE` suit.
        if (msg.command === 'session' && !msg.payload.ok && msg.payload.error.code === 'maintenance') {
            this.emitMaintenance({ site: true, message: msg.payload.error.message, features: {}, priority: false });
        }

        if (msg.command === MAINTENANCE_EVENT && msg.payload.ok) {
            const state = maintenanceStateSchema.safeParse(msg.payload.data);
            if (state.success) this.emitMaintenance(state.data);
            return;
        }

        if (msg.command === REQUEST_PROGRESS_EVENT && msg.payload.ok) {
            const update = requestProgressSchema.safeParse(msg.payload.data);
            const pending = update.success ? this.pending.get(update.data.requestId) : undefined;
            if (update.success && pending) {
                pending.rearm();
                const { done, total, step } = update.data;
                pending.onProgress?.({ done, total, step });
            }
            return;
        }

        if (msg.requestId) {
            const pending = this.pending.get(msg.requestId);
            if (pending) {
                clearTimeout(pending.timer);
                this.pending.delete(msg.requestId);
                if (msg.payload.ok) pending.resolve(msg.payload.data);
                else {
                    if (msg.payload.error.code === 'quota_exceeded') {
                        const details = msg.payload.error.details as
                            { paused?: unknown; priority?: unknown } | undefined;
                        notifyQuotaExceeded(
                            msg.payload.error.message,
                            details?.paused === true,
                            details?.priority === true
                        );
                    }
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
        return randomUuid();
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
    /**
     * L'espace que l'enveloppe porte. L'espace actif ne vaut que pour la socket
     * de SON instance : sur une autre, son id désignerait un espace sans rapport.
     */
    private stamp(explicit?: number): number | null {
        if (explicit !== undefined) return explicit;
        return getActiveInstanceId() === this.target.instanceId ? getActiveWorkspaceId() : null;
    }

    post(command: string, payload: unknown): void {
        if (this._state !== 'open' || !this.socket) return;
        if (this.socket.bufferedAmount > POST_BACKPRESSURE_BYTES) return;
        const workspaceId = this.stamp();
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
        opts: SendOptions = {}
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
            const wait = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
            const expire = (): void => {
                this.pending.delete(requestId);
                reject(new WsError('timeout', `Request ${command} timed out`));
            };
            const entry: Pending = {
                resolve: (value) => resolve(value as CommandOutput<N>),
                reject,
                timer: setTimeout(expire, wait),
                rearm: () => {
                    clearTimeout(entry.timer);
                    entry.timer = setTimeout(expire, wait);
                },
                onProgress: opts.onProgress
            };
            this.pending.set(requestId, entry);

            const post = (): void => {
                // Le délai a pu expirer, ou une fermeture purger les requêtes en
                // vol, pendant que la socket s'ouvrait.
                if (!this.pending.has(requestId)) return;
                if (!this.socket || this._state !== 'open') {
                    this.pending.delete(requestId);
                    clearTimeout(entry.timer);
                    reject(new WsError('closed', 'WS not open'));
                    return;
                }
                // L'espace actif voyage sur l'enveloppe, jamais dans le payload :
                // aucun site d'appel n'a à le passer, et le serveur n'a qu'un point
                // de résolution ; absent, il retombe sur l'espace personnel. Lu ici
                // et non à l'appel, la session pouvant l'avoir fixé entretemps.
                const workspaceId = this.stamp(opts.workspaceId);
                const envelope: ClientMessage = {
                    requestId,
                    command,
                    ...(workspaceId !== null ? { workspaceId } : {}),
                    payload: parsedInput.data
                };
                const clientParsed = clientMessageSchema.safeParse(envelope);
                if (!clientParsed.success) {
                    this.pending.delete(requestId);
                    clearTimeout(entry.timer);
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

/** Ce qu'un module peut régler d'un envoi : `timeoutMs` borne le silence de la commande. */
export type SendOptions = {
    timeoutMs?: number;
    onProgress?: (update: ProgressUpdate) => void;
    /** Viser un espace précis de cette instance plutôt que l'actif (une copie vers ailleurs). */
    workspaceId?: number;
};

/**
 * Ce que tout le client appelle `ws` : une socket par instance, et l'aiguillage
 * vers celle de l'espace actif. Les sites d'appel ne savent pas qu'il y en a
 * plusieurs.
 *
 * Seule la socket active se fait entendre des écouteurs : deux instances
 * numérotent leurs espaces chacune depuis 1, et une trame de l'autre passerait
 * pour une trame d'ici.
 */
class WsRouter {
    /** La socket de cette instance : le compte, ses instances distantes, la déconnexion. */
    readonly local = new DevEyeWs();
    private readonly remotes = new Map<number, { conn: DevEyeWs; unwire: () => void }>();
    private readonly listeners = new Set<EventListener>();
    private readonly stateListeners = new Set<(s: ConnectionState) => void>();
    private lastInstanceId: number | null = null;

    constructor() {
        this.wire(this.local, null);
        // Changer d'instance, c'est changer de socket : ceux qui se rétablissent
        // à l'ouverture (présence, abonnements) doivent le refaire sur celle-ci.
        onWorkspaceChange(() => {
            const instanceId = getActiveInstanceId();
            if (instanceId === this.lastInstanceId) return;
            this.lastInstanceId = instanceId;
            this.emitState(this.state);
        });
    }

    private wire(conn: DevEyeWs, instanceId: number | null): () => void {
        const offMessage = conn.onMessage((msg) => {
            if (conn !== this.active()) return;
            for (const fn of this.listeners) fn(msg);
        });
        const offState = conn.onStateChange((s) => {
            if (conn === this.active()) this.emitState(s);
        });
        // Hors du filtre de la socket active : les tuiles d'une instance et sa
        // page de maintenance suivent son état même quand on est ailleurs.
        const offMaintenance = conn.onMaintenance((state) => setMaintenance(instanceId, state));
        // La salle d'attente ne parle que de ce serveur-ci : une instance
        // distante qui fait attendre se contente de relancer.
        const offAdmission = instanceId === null ? conn.onAdmission(setAdmission) : () => undefined;
        // Seul ce serveur-ci livre le bundle : une instance distante à une autre
        // version est `incompatible` (remoteInstances), pas une raison de recharger.
        const offVersion = instanceId === null ? conn.onServerVersion(reloadIfOutdated) : () => undefined;
        return () => {
            offMessage();
            offState();
            offMaintenance();
            offAdmission();
            offVersion();
        };
    }

    private emitState(s: ConnectionState): void {
        for (const fn of this.stateListeners) fn(s);
    }

    /**
     * La socket de l'espace actif. `null` plutôt qu'un repli sur celle d'ici : une
     * commande estampillée d'un espace distant y viserait l'espace d'ici qui porte
     * le même numéro.
     */
    private active(): DevEyeWs | null {
        const instanceId = getActiveInstanceId();
        return instanceId === null ? this.local : (this.remotes.get(instanceId)?.conn ?? null);
    }

    /** La socket d'une instance précise, active ou non : `null` pour celle-ci. */
    connectionFor(instanceId: number | null): DevEyeWs | null {
        return instanceId === null ? this.local : (this.remotes.get(instanceId)?.conn ?? null);
    }

    attachRemote(target: WsTarget & { instanceId: number }): DevEyeWs {
        this.detachRemote(target.instanceId);
        const conn = new DevEyeWs(target);
        this.remotes.set(target.instanceId, { conn, unwire: this.wire(conn, target.instanceId) });
        return conn;
    }

    detachRemote(instanceId: number): void {
        const entry = this.remotes.get(instanceId);
        if (!entry) return;
        entry.unwire();
        entry.conn.close();
        this.remotes.delete(instanceId);
        forgetMaintenance(instanceId);
    }

    get state(): ConnectionState {
        return this.active()?.state ?? 'closed';
    }

    get hasConnected(): boolean {
        return this.active()?.hasConnected ?? false;
    }

    onMessage(fn: EventListener): () => void {
        this.listeners.add(fn);
        return () => this.listeners.delete(fn);
    }

    onStateChange(fn: (s: ConnectionState) => void): () => void {
        this.stateListeners.add(fn);
        return () => this.stateListeners.delete(fn);
    }

    /** La session de CETTE instance : celle d'une instance distante se règle dans `remoteSessions`. */
    onUnauthorized(fn: () => void): () => void {
        return this.local.onUnauthorized(fn);
    }

    connect(): Promise<void> {
        return this.local.connect();
    }

    /** Déconnexion : tout se ferme, ici comme ailleurs. */
    close(): void {
        for (const instanceId of [...this.remotes.keys()]) this.detachRemote(instanceId);
        this.local.close();
    }

    reconnect(): Promise<void> {
        return (this.active() ?? this.local).reconnect();
    }

    post(command: string, payload: unknown): void {
        this.active()?.post(command, payload);
    }

    /** À toutes les sockets ouvertes, celle d'ici et les distantes. */
    postEverywhere(command: string, payload: unknown): void {
        this.local.post(command, payload);
        for (const { conn } of this.remotes.values()) conn.post(command, payload);
    }

    send<N extends FeatureCommandName>(
        command: N,
        input: CommandInput<N>,
        opts: SendOptions = {}
    ): Promise<CommandOutput<N>> {
        const conn = this.active();
        if (!conn) return Promise.reject(new WsError('closed', 'Instance distante déconnectée'));
        return conn.send(command, input, opts);
    }
}

export const ws = new WsRouter();
