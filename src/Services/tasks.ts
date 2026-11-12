import type { WebSocket } from '@fastify/websocket';
import { createHash, randomUUID } from 'crypto';
import {
    ok,
    REQUEST_PROGRESS_EVENT,
    TASK_REMOVED_EVENT,
    TASK_TEXT_MAX,
    TASK_TITLE_MAX,
    TASK_UPDATE_EVENT,
    type CommandTask,
    type ErrorCode,
    type ServerMessage,
    type TaskRoster,
    type TaskSnapshot
} from '@deveye/types';
import type { CommandProgress } from '@deveye/types/sdk/server';

import type { RevokedSessions } from '@/live/hub';
import { progressGate, type ProgressGate } from '@/ws/progress';

/**
 * Le délai d'une annonce aux autres onglets : une commande éclair, un refus
 * qui se rejoue ou un résultat aussitôt retiré n'y clignotent pas.
 */
const ANNOUNCE_AFTER_MS = 300;
const FINISHED_TTL_MS = 24 * 3_600_000;
/** Le temps laissé à la page qui attend la réponse pour retrouver le réseau. */
const REPLY_TTL_MS = 10 * 60_000;
/** Partie sur une socket ouverte, qui pouvait être déjà morte : gardée encore un peu. */
const REPLY_SENT_TTL_MS = 60_000;
const REPLY_MAX_BYTES = 256 * 1024;
const REPLIES_PER_USER_BYTES = 1024 * 1024;
const PER_USER_MAX = 50;
const TOTAL_MAX = 10_000;
const SWEEP_MS = 60_000;

/** Ces refus se rejouent après une invite : l'opération n'a pas échoué, elle n'a pas commencé. */
const REPLAYABLE: ReadonlySet<ErrorCode> = new Set<ErrorCode>(['stepup_required', 'locked']);

const SOCKET_OPEN = 1;

const CANCELLING_STEP = 'Annulation…';
const SERVICE_STOPPED = 'Le service a été arrêté pendant l’opération.';

/** Ce que le registre pousse aux sockets de navigateur (`live/hub.ts`). */
export interface TaskLive {
    toUser(
        userId: number,
        command: string,
        data: unknown,
        options?: { except?: WebSocket | null; must?: boolean }
    ): void;
}

interface Deps {
    live: TaskLive;
}

export interface TaskOpening {
    userId: number;
    sessionId: string;
    socket: WebSocket;
    requestId: string;
    workspaceId: number;
    tag: CommandTask;
    /**
     * L'étage gardé de l'espace attend le mot de passe du compte. Un libellé ou
     * une réponse peut en citer le contenu : rien n'en est alors montré ni
     * retenu, le registre sait seulement, tant que la commande tourne, à quelle
     * socket répondre.
     */
    guarded: boolean;
}

/** L'opération d'une commande en cours, vue du dispatcheur. */
export interface TrackedTask {
    report(update: CommandProgress): void;
    /** La réponse de la commande : remise à la socket qui l'attend à cet instant, retenue sinon. */
    settle(reply: ServerMessage): void;
}

export interface TaskClaim {
    id: string;
    requestId: string;
}

/** Le registre, lié à une connexion : ce qu'un handler en voit. */
export interface TaskTransport {
    /** Rend les opérations perdues : inconnues, lancées ailleurs, ou finies sans réponse retenue. */
    attach(claims: readonly TaskClaim[]): string[];
    /** Rend les opérations retirées. */
    dismiss(ids: readonly string[]): string[];
    /** Demande son arrêt à une opération qu'un service sait arrêter ; faux quand elle ne le peut pas. */
    cancel(id: string): Promise<boolean>;
}

/** Le travail qu'un service mène pour un compte, sans commande qui l'attende. */
export interface ServiceTaskOpening {
    userId: number;
    workspaceId: number;
    feature: string;
    title: string;
    subject?: string;
    itemId?: string;
    /** Avec une clé, rouvrir le même travail pendant qu'il tourne rend la même opération. */
    key?: string;
    cancel?: () => void | Promise<void>;
    /** Le compte lit-il cette fonctionnalité dans cet espace ? Rien n'est montré avant un oui. */
    allowed(): Promise<boolean>;
}

export interface ServiceTask {
    readonly id: string;
    progress(update: CommandProgress): void;
    done(note?: string): void;
    fail(message: string, code?: ErrorCode): void;
    cancelled(): void;
}

interface ServiceSide {
    allowed(): Promise<boolean>;
    cancel?: () => void | Promise<void>;
}

interface Entry {
    readonly userId: number;
    /** La session qui l'a lancée : la seule à pouvoir réclamer la réponse. */
    readonly sessionId: string;
    /** Jamais diffusé : le présenter prouve qu'on attend cette réponse. */
    readonly requestId: string;
    readonly snapshot: TaskSnapshot;
    readonly gate: ProgressGate;
    /** La socket qui attend la réponse, `null` quand elle est partie. */
    socket: WebSocket | null;
    announced: boolean;
    /**
     * Rien n'en est publié et sa fin l'efface : retirée de la zone alors qu'elle
     * tourne, ou lancée dans un espace gardé par mot de passe.
     */
    hidden: boolean;
    announceTimer: ReturnType<typeof setTimeout> | null;
    /** Sa commande a répondu : une seconde réponse du dispatcheur ne compte pas. */
    settled: boolean;
    reply: { raw: string; bytes: number; until: number } | null;
    /** Échéance de l'instantané, une fois l'opération finie. */
    until: number;
    /** Menée par un service : aucune socket n'en attend la réponse. */
    service: ServiceSide | null;
}

/**
 * Les opérations longues des comptes : les commandes qu'un client a marquées
 * (`task` de l'enveloppe), et le travail qu'un service mène pour un membre. Le
 * registre garde leur état pour les onglets du compte, et la réponse d'une
 * commande pour la page qui l'attend, qu'une coupure ou un rechargement en a
 * séparée. Une opération n'est jamais montrée qu'à son compte. Tout est en
 * mémoire, le processus étant seul : un redémarrage oublie tout, et `epoch` le
 * dit aux clients.
 */
export class TaskRegistry {
    /** Sans hub (un handler éprouvé seul), le registre suit sans rien pousser. */
    private deps: Deps | null = null;
    private epoch = randomUUID();
    private readonly byUser = new Map<number, Map<string, Entry>>();
    private total = 0;
    private timer: ReturnType<typeof setInterval> | null = null;

    init(deps: Deps): void {
        this.deps = deps;
        this.epoch = randomUUID();
        this.timer = setInterval(() => this.sweep(), SWEEP_MS);
        this.timer.unref();
    }

    close(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
        for (const mine of this.byUser.values()) for (const entry of mine.values()) silence(entry);
        this.byUser.clear();
        this.total = 0;
    }

    /**
     * Ouvre l'opération d'une commande que ses gardes ont laissée passer. `null`
     * quand elle ne peut pas être suivie (plafond atteint, id déjà pris) : la
     * commande tourne alors comme n'importe quelle autre.
     */
    open(o: TaskOpening): TrackedTask | null {
        const previous = this.byUser.get(o.userId)?.get(o.tag.id);
        if (previous) {
            // Un id ne se reprend que par la session qui l'a lancé, et une fois l'opération finie.
            if (previous.snapshot.state === 'running' || previous.sessionId !== o.sessionId) return null;
            this.forget(previous);
        }
        const mine = this.byUser.get(o.userId);
        if (mine && mine.size >= PER_USER_MAX && !this.evictOldest(mine)) return null;
        if (this.total >= TOTAL_MAX) {
            this.sweep();
            if (this.total >= TOTAL_MAX) return null;
        }

        const entry: Entry = {
            userId: o.userId,
            sessionId: o.sessionId,
            requestId: o.requestId,
            snapshot: {
                id: o.tag.id,
                state: 'running',
                title: o.tag.title,
                subject: o.tag.subject ?? null,
                feature: o.tag.feature ?? null,
                itemId: o.tag.itemId ?? null,
                key: o.tag.key ?? null,
                workspaceId: o.workspaceId,
                startedAt: Date.now(),
                endedAt: null,
                progress: null,
                cancellable: false,
                done: o.tag.done ?? null,
                failed: o.tag.failed ?? null,
                error: null
            },
            gate: progressGate((update) => this.progressed(entry, update)),
            socket: o.socket,
            announced: false,
            hidden: o.guarded,
            announceTimer: null,
            settled: false,
            reply: null,
            until: 0,
            service: null
        };
        // Le minuteur survit à la fin de l'opération : un résultat éclair que sa
        // page retire aussitôt n'est jamais annoncé, un résultat qui reste l'est.
        if (!entry.hidden) this.announceSoon(entry);

        this.store(entry);
        return {
            report: (update) => entry.gate.report(update),
            settle: (reply) => this.settle(entry, reply)
        };
    }

    /**
     * Ouvre le travail qu'un service mène pour un compte. Rien n'en est montré
     * avant que `allowed` ait dit oui ; sur un non, ou passé un plafond, la
     * poignée rendue ne fait rien.
     */
    openService(o: ServiceTaskOpening): ServiceTask {
        // Un id dérivé de ce que le travail vise : le service qui le retrouve
        // après un redémarrage rouvre la même opération, et les onglets qui la
        // croyaient interrompue la voient reprendre.
        const id =
            o.key === undefined
                ? randomUUID()
                : `svc-${createHash('sha256')
                      .update([o.feature, o.workspaceId, o.itemId ?? '', o.key].join('\0'))
                      .digest('hex')
                      .slice(0, 32)}`;
        const mine = this.byUser.get(o.userId);
        const previous = mine?.get(id);
        if (previous) {
            if (!previous.settled && previous.service) {
                previous.service = { allowed: o.allowed, cancel: o.cancel };
                this.setCancellable(previous, o.cancel !== undefined);
                return this.serviceHandle(previous);
            }
            if (!previous.settled) return inertTask(id);
            this.forget(previous);
        }
        if (mine && mine.size >= PER_USER_MAX && !this.evictOldest(mine)) return inertTask(id);
        if (this.total >= TOTAL_MAX) {
            this.sweep();
            if (this.total >= TOTAL_MAX) return inertTask(id);
        }

        const entry: Entry = {
            userId: o.userId,
            sessionId: '',
            requestId: '',
            snapshot: {
                id,
                state: 'running',
                title: o.title.trim().slice(0, TASK_TITLE_MAX),
                subject: o.subject?.trim().slice(0, TASK_TEXT_MAX) || null,
                feature: o.feature,
                itemId: bounded(o.itemId),
                key: bounded(o.key),
                workspaceId: o.workspaceId,
                startedAt: Date.now(),
                endedAt: null,
                progress: null,
                cancellable: o.cancel !== undefined,
                done: null,
                failed: null,
                error: null
            },
            gate: progressGate((update) => this.progressed(entry, update)),
            socket: null,
            announced: false,
            hidden: false,
            announceTimer: null,
            settled: false,
            reply: null,
            until: 0,
            service: { allowed: o.allowed, cancel: o.cancel }
        };
        this.store(entry);
        void o.allowed().then(
            (allowed) => this.admit(entry, allowed),
            () => this.admit(entry, false)
        );
        return this.serviceHandle(entry);
    }

    /** Le service d'une fonctionnalité s'arrête : ce qu'il menait ne finira pas. */
    stopFeature(feature: string): void {
        for (const mine of [...this.byUser.values()]) {
            for (const entry of [...mine.values()]) {
                if (entry.service && entry.snapshot.feature === feature) {
                    this.end(entry, 'failed', SERVICE_STOPPED, 'maintenance');
                }
            }
        }
    }

    /**
     * La personne demande l'arrêt d'une opération qu'un service a dit savoir
     * arrêter. Le droit est relu : il a pu tomber depuis l'ouverture.
     */
    async cancel(userId: number, id: string): Promise<boolean> {
        const entry = this.byUser.get(userId)?.get(id);
        const side = entry?.service;
        if (!entry || !side?.cancel || entry.settled || !entry.announced || entry.hidden) return false;
        if (!(await side.allowed())) return false;
        const cancel = side.cancel;
        if (entry.settled || !cancel) return false;
        // Une demande suffit : le service retire l'opération quand il s'est arrêté.
        side.cancel = undefined;
        entry.snapshot.cancellable = false;
        entry.snapshot.progress = { ...entry.snapshot.progress, step: CANCELLING_STEP };
        this.publish(entry);
        await cancel();
        return true;
    }

    /** Ce que la zone d'un compte montre à l'ouverture d'une socket. */
    roster(userId: number): TaskRoster {
        const list: TaskSnapshot[] = [];
        for (const entry of this.byUser.get(userId)?.values() ?? []) {
            if (entry.announced && !entry.hidden) list.push(entry.snapshot);
        }
        return { epoch: this.epoch, list };
    }

    transport(socket: WebSocket, userId: number, sessionId: string): TaskTransport {
        return {
            attach: (claims) => this.attach(socket, userId, sessionId, claims),
            dismiss: (ids) => this.dismiss(userId, ids),
            cancel: (id) => this.cancel(userId, id)
        };
    }

    /**
     * Une page réclame les réponses qu'elle attend encore, sa socket revenue.
     * Une opération en cours répondra à cette socket ; une opération finie rend
     * sa réponse retenue aussitôt.
     */
    attach(socket: WebSocket, userId: number, sessionId: string, claims: readonly TaskClaim[]): string[] {
        const mine = this.byUser.get(userId);
        const lost: string[] = [];
        for (const { id, requestId } of claims) {
            const entry = mine?.get(id);
            if (!entry || entry.requestId !== requestId || entry.sessionId !== sessionId) {
                lost.push(id);
            } else if (entry.snapshot.state === 'running') {
                entry.socket = socket;
            } else if (entry.reply && deliver(socket, entry.reply.raw)) {
                entry.reply.until = Math.min(entry.reply.until, Date.now() + REPLY_SENT_TTL_MS);
            } else {
                lost.push(id);
            }
        }
        return lost;
    }

    /**
     * Retire des opérations de la zone du compte, dans tous ses onglets. Une
     * opération en cours n'est que délaissée : sa commande va à son terme, et
     * sa réponse part encore vers la socket qui l'attend.
     */
    dismiss(userId: number, ids: readonly string[]): string[] {
        const mine = this.byUser.get(userId);
        const removed: string[] = [];
        for (const id of new Set(ids)) {
            const entry = mine?.get(id);
            if (!entry || entry.hidden) continue;
            removed.push(id);
            if (entry.snapshot.state === 'running') {
                this.announceRemoved(entry);
                entry.hidden = true;
                clearAnnounce(entry);
            } else {
                this.forget(entry);
            }
        }
        return removed;
    }

    /** La socket est partie : les réponses qu'elle attendait seront retenues. */
    dropSocket(userId: number, socket: WebSocket): void {
        for (const entry of this.byUser.get(userId)?.values() ?? []) {
            if (entry.socket === socket) entry.socket = null;
        }
    }

    /** Des sessions sont révoquées : personne ne réclamera plus les réponses qu'elles attendaient. */
    revoke(gone: RevokedSessions): void {
        const owners = 'userId' in gone ? [this.byUser.get(gone.userId)] : [...this.byUser.values()];
        for (const mine of owners) {
            for (const entry of mine?.values() ?? []) {
                const hit =
                    'userId' in gone ? entry.sessionId !== gone.keepSessionId : entry.sessionId === gone.sessionId;
                if (!hit) continue;
                entry.reply = null;
                entry.socket = null;
            }
        }
    }

    private settle(entry: Entry, reply: ServerMessage): void {
        if (entry.settled) return;
        entry.settled = true;
        entry.gate.close();
        const raw = JSON.stringify(reply);
        const sent = deliver(entry.socket, raw);
        const failure = reply.payload.ok ? null : reply.payload.error;
        if (entry.hidden || (failure && REPLAYABLE.has(failure.code))) {
            this.forget(entry);
            return;
        }
        const now = Date.now();
        entry.snapshot.state = failure ? 'failed' : 'done';
        entry.snapshot.endedAt = now;
        // Jamais les `details` du refus : ils peuvent citer l'entrée de la commande.
        entry.snapshot.error = failure ? { code: failure.code, message: failure.message.slice(0, 500) } : null;
        entry.until = now + FINISHED_TTL_MS;
        this.retain(entry, raw, now + (sent ? REPLY_SENT_TTL_MS : REPLY_TTL_MS));
        // La page qui vient de recevoir la réponse retire l'opération restée
        // devant elle : lui en laisser le temps évite aux autres onglets un
        // résultat qui ne fait que passer.
        if (sent) this.announceSoon(entry);
        else this.publish(entry, true);
    }

    private announceSoon(entry: Entry): void {
        clearAnnounce(entry);
        entry.announceTimer = setTimeout(() => {
            entry.announceTimer = null;
            entry.announced = true;
            this.publish(entry, entry.settled);
        }, ANNOUNCE_AFTER_MS);
        entry.announceTimer.unref();
    }

    private store(entry: Entry): void {
        let mine = this.byUser.get(entry.userId);
        if (!mine) this.byUser.set(entry.userId, (mine = new Map()));
        mine.set(entry.snapshot.id, entry);
        this.total += 1;
    }

    /** Le verdict d'accès d'une opération de service : elle paraît, ou n'aura jamais existé. */
    private admit(entry: Entry, allowed: boolean): void {
        if (this.byUser.get(entry.userId)?.get(entry.snapshot.id) !== entry) return;
        if (!allowed) {
            entry.settled = true;
            this.forget(entry);
            return;
        }
        entry.announced = true;
        this.publish(entry, entry.settled);
    }

    private serviceHandle(entry: Entry): ServiceTask {
        return {
            id: entry.snapshot.id,
            progress: (update) => entry.gate.report(update),
            done: (note) => this.end(entry, 'done', note),
            fail: (message, code = 'internal') => this.end(entry, 'failed', message, code),
            cancelled: () => {
                if (entry.settled) return;
                entry.settled = true;
                this.forget(entry);
            }
        };
    }

    private setCancellable(entry: Entry, cancellable: boolean): void {
        if (entry.snapshot.cancellable === cancellable) return;
        entry.snapshot.cancellable = cancellable;
        this.publish(entry);
    }

    private end(entry: Entry, state: 'done' | 'failed', text: string | undefined, code: ErrorCode = 'internal'): void {
        if (entry.settled) return;
        entry.settled = true;
        entry.gate.close();
        if (entry.hidden) {
            this.forget(entry);
            return;
        }
        const now = Date.now();
        const sentence = text?.trim().slice(0, TASK_TEXT_MAX) || null;
        entry.snapshot.state = state;
        entry.snapshot.endedAt = now;
        entry.snapshot.cancellable = false;
        if (state === 'done') entry.snapshot.done = sentence;
        else {
            entry.snapshot.failed = sentence;
            entry.snapshot.error = sentence === null ? null : { code, message: sentence };
        }
        entry.until = now + FINISHED_TTL_MS;
        this.publish(entry, true);
    }

    private progressed(entry: Entry, update: CommandProgress): void {
        entry.snapshot.progress = update;
        const frame: ServerMessage = {
            command: REQUEST_PROGRESS_EVENT,
            payload: ok({ requestId: entry.requestId, ...update })
        };
        deliver(entry.socket, JSON.stringify(frame));
        this.publish(entry);
    }

    /**
     * La socket qui attend la réponse est écartée : sa page suit l'opération
     * par sa requête, pas par ces trames.
     */
    private publish(entry: Entry, must = false): void {
        if (!entry.announced || entry.hidden) return;
        this.deps?.live.toUser(entry.userId, TASK_UPDATE_EVENT, entry.snapshot, { except: entry.socket, must });
    }

    private announceRemoved(entry: Entry): void {
        if (!entry.announced || entry.hidden) return;
        this.deps?.live.toUser(entry.userId, TASK_REMOVED_EVENT, { ids: [entry.snapshot.id] }, { must: true });
    }

    /** Une réponse trop lourde n'est pas retenue ; les plus proches de leur échéance cèdent la place. */
    private retain(entry: Entry, raw: string, until: number): void {
        const bytes = Buffer.byteLength(raw);
        if (bytes > REPLY_MAX_BYTES) return;
        const holders = [...(this.byUser.get(entry.userId)?.values() ?? [])]
            .filter((other) => other.reply !== null)
            .sort((a, b) => a.reply!.until - b.reply!.until);
        let held = holders.reduce((sum, other) => sum + other.reply!.bytes, 0);
        for (const other of holders) {
            if (held + bytes <= REPLIES_PER_USER_BYTES) break;
            held -= other.reply!.bytes;
            other.reply = null;
        }
        entry.reply = { raw, bytes, until };
    }

    private evictOldest(mine: Map<string, Entry>): boolean {
        let oldest: Entry | null = null;
        for (const entry of mine.values()) {
            if (entry.snapshot.state === 'running') continue;
            if (!oldest || entry.until < oldest.until) oldest = entry;
        }
        if (oldest) this.forget(oldest);
        return oldest !== null;
    }

    private forget(entry: Entry): void {
        this.announceRemoved(entry);
        silence(entry);
        const mine = this.byUser.get(entry.userId);
        if (mine?.get(entry.snapshot.id) !== entry) return;
        mine.delete(entry.snapshot.id);
        this.total -= 1;
        if (mine.size === 0) this.byUser.delete(entry.userId);
    }

    private sweep(): void {
        const now = Date.now();
        for (const mine of [...this.byUser.values()]) {
            for (const entry of [...mine.values()]) {
                if (entry.reply && entry.reply.until <= now) entry.reply = null;
                if (entry.snapshot.state !== 'running' && entry.until <= now) this.forget(entry);
            }
        }
    }
}

/** Un identifiant que l'instantané sait porter, ou rien. */
function bounded(value: string | undefined): string | null {
    return value !== undefined && value !== '' && value.length <= 64 ? value : null;
}

function inertTask(id: string): ServiceTask {
    const nothing = (): void => undefined;
    return { id, progress: nothing, done: nothing, fail: nothing, cancelled: nothing };
}

function clearAnnounce(entry: Entry): void {
    if (entry.announceTimer) clearTimeout(entry.announceTimer);
    entry.announceTimer = null;
}

function silence(entry: Entry): void {
    clearAnnounce(entry);
    entry.gate.close();
}

/** Vrai quand la trame est partie sur une socket ouverte : rien ne dit qu'elle est arrivée. */
function deliver(socket: WebSocket | null, raw: string): boolean {
    if (!socket || socket.readyState !== SOCKET_OPEN) return false;
    try {
        socket.send(raw);
        return true;
    } catch {
        return false;
    }
}

export const tasks = new TaskRegistry();
