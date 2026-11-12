import { useSyncExternalStore } from 'react';
import { TASK_TEXT_MAX, TASK_TITLE_MAX, type CommandTask, type TaskRoster, type TaskSnapshot } from '@deveye/types';

import type { SendOptions } from '@/api/ws';
import type { ErrorNoteInput } from '@/Components/ErrorNote';

import { humanizeError } from '../api/humanizeError';
import { randomUuid } from '../randomUuid';

/**
 * Les opérations longues en cours et leurs résultats : ce que montrent le
 * dialogue réductible, la puce de la barre et son panneau.
 *
 * Sans import de `api/ws` ni de `stores/workspace` : ils lisent l'environnement
 * de Vite au chargement, et ce magasin se teste sous Node.
 */

/** Le délai laissé à la commande d'une opération pour partir, quand la socket se fait attendre. */
const SILENCE_MS = 120_000;
/** Au-delà, les opérations finies les plus anciennes cèdent la place. */
const FINISHED_MAX = 30;
/** L'écart minimal entre deux avancements publiés d'une même opération. */
export const PROGRESS_GAP_MS = 100;

export const LOST_NOTE = 'La connexion a été coupée pendant l’opération. Vérifiez son résultat avant de la relancer.';
export const SILENT_NOTE =
    'Le serveur ne donne plus de nouvelles. L’opération se poursuit peut-être : vérifiez son résultat avant de la relancer.';
export const RESTART_NOTE =
    'Le serveur a redémarré pendant l’opération : elle a pu s’interrompre. Vérifiez son résultat avant de la relancer.';
export const FORGOTTEN_NOTE =
    'Le serveur ne garde plus trace de cette opération. Vérifiez son résultat avant de la relancer.';
const ENDED_OFFLINE_NOTE = 'L’opération s’est terminée pendant que cette page était déconnectée.';
const FAILED_NOTE = 'L’opération a échoué.';
const CONFLICT_NOTE = 'Cette opération est déjà en cours.';
const CANCELLED_NOTE = 'Opération annulée.';
const CANCELLING_STEP = 'Annulation…';
const DONE_NOTE = 'Terminé.';

/** `lost` : personne ne sait comment elle a fini (serveur redémarré, connexion coupée avant l'envoi). */
export type TaskState = 'running' | 'done' | 'failed' | 'lost';

/** L'espace où l'opération a été lancée : `instanceId` à `null` pour cette instance. */
export interface TaskOrigin {
    instanceId: number | null;
    workspaceId: number | null;
}

/** Ce qu'un écran lit d'une opération en cours. */
export interface Task {
    id: string;
    feature: string;
    itemId?: string;
    key?: string;
    title: string;
    subject?: string;
    /** De 0 à 1 quand l'avancement se mesure. */
    value?: number;
    step?: string;
    startedAt: number;
}

export interface TaskRecord extends Task {
    origin: TaskOrigin;
    description?: string;
    state: TaskState;
    endedAt?: number;
    /** La phrase d'un succès. */
    note?: string;
    /** Celle d'un échec ou d'une perte. */
    error?: ErrorNoteInput;
    /** Le travail se fait dans cet onglet : le fermer le tue. */
    local: boolean;
    minimizable: boolean;
    cancellable: boolean;
    /** Son dialogue est demandé à l'écran. */
    foreground: boolean;
    /** A quitté le premier plan au moins une fois : son résultat revient à la zone, plus à l'écran appelant. */
    detached: boolean;
    raisedAt: number;
    /** Un succès que le panneau a déjà montré : il part à sa fermeture. */
    seen: boolean;
    /** Cette page l'a lancée : elle en attend la réponse et en tient le dialogue. */
    owned: boolean;
    /** Le serveur la suit : la retirer d'ici la retire de tous les onglets du compte. */
    tracked: boolean;
}

/** Les options d'une opération, l'origine et la note d'échec déjà résolues par `sdk/tasks`. */
export interface TaskSpec<T> {
    feature: string;
    origin: TaskOrigin;
    title: string;
    subject?: string;
    description?: string;
    itemId?: string;
    key?: string;
    dialog: boolean;
    /** Sans dialogue, l'écran dessine l'attente chez lui : la zone ne la prend que s'il s'en va. */
    inPlace?: boolean;
    minimizable: boolean;
    local: boolean;
    done?: string | ((result: T) => string);
    failure: (error: unknown) => ErrorNoteInput;
    /** Le repli de la phrase d'échec, pour un onglet qui n'a pas lancé l'opération. */
    failed?: string;
    cancel?: () => void;
    onDetach?: () => void;
}

export interface TaskContext {
    /** L'id de l'opération, celui que rend `useTasks`. */
    id: string;
    /** À passer à LA commande de l'opération : c'est elle que le serveur suit, avancement et espace d'origine compris. */
    sendOptions: SendOptions;
    /** L'avancement d'un travail fait dans l'onglet ; `null` efface la valeur. */
    report(update: { value?: number | null; step?: string | null }): void;
    /** Ramène le dialogue devant, avant une invite qui a besoin de la personne. */
    raise(): void;
    origin: TaskOrigin;
}

export type TaskErrorCode = 'closed' | 'timeout' | 'lost' | 'conflict' | 'cancelled';

/** Le rejet qu'une opération écrit elle-même : sa phrase est déjà la bonne. */
export class TaskError extends Error {
    readonly code: TaskErrorCode;

    constructor(code: TaskErrorCode, message: string) {
        super(message);
        this.name = 'TaskError';
        this.code = code;
    }
}

interface Handle {
    cancel?: () => void;
    onDetach?: () => void;
    cancelRequested: boolean;
    /** L'avancement retenu entre deux publications, et la minuterie qui le publiera. */
    progressAt: number;
    pending: Partial<TaskRecord> | null;
    timer: ReturnType<typeof setTimeout> | null;
    /** Ce que le serveur dit de l'opération quand il en parle à cette page malgré sa requête en vol. */
    snapshot: TaskSnapshot | null;
    /** L'époque du serveur au lancement : autre à la fin, il a redémarré entre-temps. */
    epoch: string | undefined;
}

/** Ce que le magasin demande au serveur d'une instance, branché par le transport. */
export interface TaskRemote {
    /** Retire des opérations de la zone du compte. */
    dismiss(instanceId: number | null, ids: readonly string[]): void;
    /** Demande son arrêt à une opération qu'un service mène. */
    cancel(instanceId: number | null, id: string): void;
}

let records: readonly TaskRecord[] = [];
const handles = new Map<string, Handle>();
const listeners = new Set<() => void>();
/** L'époque du registre de chaque instance, telle que sa dernière liste d'ouverture l'a dite. */
const epochs = new Map<number | null, string>();
let remote: TaskRemote | null = null;
let panelOpen = false;
let raiseSeq = 0;

export function setTaskRemote(next: TaskRemote | null): void {
    remote = next;
}

function publish(next: readonly TaskRecord[]): void {
    records = next;
    for (const listener of listeners) listener();
}

function find(id: string): TaskRecord | undefined {
    return records.find((r) => r.id === id);
}

function patch(id: string, change: Partial<TaskRecord>): void {
    if (!find(id)) return;
    publish(records.map((r) => (r.id === id ? { ...r, ...change } : r)));
}

/** Oublie ce qui tenait l'opération en vie : un avancement retenu ne se publie plus. */
function release(id: string): void {
    const handle = handles.get(id);
    if (handle?.timer) clearTimeout(handle.timer);
    handles.delete(id);
}

/** Retire des opérations d'ici et, pour celles que le serveur suit, de tous les onglets du compte. */
function discard(gone: readonly TaskRecord[]): void {
    if (gone.length === 0) return;
    const ids = new Set(gone.map((r) => r.id));
    for (const id of ids) release(id);
    publish(records.filter((r) => !ids.has(r.id)));
    const byInstance = new Map<number | null, string[]>();
    for (const record of gone) {
        if (!record.tracked) continue;
        const list = byInstance.get(record.origin.instanceId);
        if (list) list.push(record.id);
        else byInstance.set(record.origin.instanceId, [record.id]);
    }
    for (const [instanceId, list] of byInstance) remote?.dismiss(instanceId, list);
}

/**
 * Publie un avancement, dix fois par seconde au plus par opération, le dernier
 * toujours. Chaque publication redessine tout écran qui lit le magasin, et un
 * travail local en rapporte des centaines par seconde : sans ce frein, le fil
 * de l'écran ne fait plus que ça, et le dialogue lui-même n'arrive pas à paraître.
 */
function progress(id: string, change: Partial<TaskRecord>): void {
    const handle = handles.get(id);
    if (!handle || handle.cancelRequested) return;
    const wait = handle.progressAt + PROGRESS_GAP_MS - Date.now();
    if (wait <= 0 && handle.timer === null) {
        handle.progressAt = Date.now();
        patch(id, change);
        return;
    }
    handle.pending = { ...handle.pending, ...change };
    handle.timer ??= setTimeout(
        () => {
            handle.timer = null;
            const pending = handle.pending;
            handle.pending = null;
            if (pending === null || handles.get(id) !== handle) return;
            handle.progressAt = Date.now();
            patch(id, pending);
        },
        Math.max(0, wait)
    );
}

/** L'étape annoncée et le compte, en une phrase. */
export function stepOf(
    step: string | undefined,
    done: number | undefined,
    total: number | undefined
): string | undefined {
    // Sur cent, un compte est un pourcentage, et se lit mieux ainsi.
    const count =
        total === undefined || total <= 0 ? undefined : total === 100 ? `${done ?? 0} %` : `${done ?? 0} sur ${total}`;
    if (step && count) return `${step} : ${count}`;
    return step ?? count;
}

function codeOf(error: unknown): string | null {
    const raw = (error as { code?: unknown } | null)?.code;
    return typeof raw === 'string' ? raw : null;
}

function sameTarget(record: TaskRecord, spec: Pick<TaskRecord, 'feature' | 'key' | 'itemId' | 'origin'>): boolean {
    return (
        record.feature === spec.feature &&
        record.key === spec.key &&
        record.itemId === spec.itemId &&
        record.origin.instanceId === spec.origin.instanceId &&
        record.origin.workspaceId === spec.origin.workspaceId
    );
}

/** Solde une opération détachée : son résultat reste dans la zone. */
function finish(id: string, change: Partial<TaskRecord>): void {
    const settled = records.map((r) =>
        r.id === id ? { ...r, ...change, endedAt: Date.now(), foreground: false, seen: panelOpen } : r
    );
    const finished = settled.filter((r) => r.state !== 'running');
    const surplus = [...finished]
        .sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0))
        .slice(0, Math.max(0, finished.length - FINISHED_MAX));
    publish(settled);
    discard(surplus);
}

function succeed<T>(id: string, spec: TaskSpec<T>, result: T): void {
    const record = find(id);
    release(id);
    if (!record) return;
    if (!record.detached) {
        discard([record]);
        return;
    }
    let note = DONE_NOTE;
    if (typeof spec.done === 'string') note = spec.done;
    else if (spec.done) {
        try {
            note = spec.done(result);
        } catch {
            note = DONE_NOTE;
        }
    }
    finish(id, { state: 'done', note });
}

/** Solde un échec, et rend ce que la promesse de l'appelant doit rejeter. */
function fail<T>(id: string, spec: TaskSpec<T>, error: unknown): unknown {
    const record = find(id);
    const handle = handles.get(id);
    release(id);
    if (!record) return error;
    if (handle?.cancelRequested) {
        discard([record]);
        return new TaskError('cancelled', CANCELLED_NOTE);
    }

    const code = codeOf(error);
    let thrown: unknown = error;
    let change: Partial<TaskRecord>;
    if (!record.local && code === 'lost') {
        // Le serveur ne rendra plus la réponse. S'il a dit la fin de
        // l'opération entre-temps, elle fait foi ; sinon personne ne la connaît.
        const told = handle?.snapshot;
        if (told?.state === 'done') {
            thrown = new TaskError('lost', ENDED_OFFLINE_NOTE);
            change = { state: 'done', note: typeof spec.done === 'string' ? spec.done : (told.done ?? DONE_NOTE) };
        } else if (told?.state === 'failed') {
            const note = failureOf(told);
            thrown = new TaskError('lost', note.message);
            change = { state: 'failed', error: note };
        } else {
            const message = handle?.epoch === epochs.get(record.origin.instanceId) ? FORGOTTEN_NOTE : RESTART_NOTE;
            thrown = new TaskError('lost', message);
            change = { state: 'lost', error: { message, code: 'lost' }, tracked: false };
        }
    } else if (!record.local && code === 'closed') {
        // Coupée avant que la commande parte : une commande suivie survit à sa socket.
        thrown = new TaskError('closed', LOST_NOTE);
        change = { state: 'lost', error: { message: LOST_NOTE, code: 'closed' } };
    } else if (!record.local && code === 'timeout') {
        thrown = new TaskError('timeout', SILENT_NOTE);
        change = { state: 'failed', error: { message: SILENT_NOTE, code: 'timeout' } };
    } else {
        change = { state: 'failed', error: spec.failure(error) };
    }

    if (!record.detached) discard([record]);
    else finish(id, change);
    return thrown;
}

function clip(text: string | undefined, max: number): string | undefined {
    const clipped = text?.trim().slice(0, max);
    return clipped ? clipped : undefined;
}

function short(value: string | undefined): string | undefined {
    return value !== undefined && value !== '' && value.length <= 64 ? value : undefined;
}

/** Ce que la commande dit de l'opération au serveur, dans les bornes de l'enveloppe. */
function tagOf<T>(id: string, spec: TaskSpec<T>): CommandTask | undefined {
    const title = clip(spec.title, TASK_TITLE_MAX);
    if (spec.local || title === undefined) return undefined;
    return {
        id,
        title,
        subject: clip(spec.subject, TASK_TEXT_MAX),
        feature: short(spec.feature),
        itemId: short(spec.itemId),
        key: short(spec.key),
        done: typeof spec.done === 'string' ? clip(spec.done, TASK_TEXT_MAX) : undefined,
        failed: clip(spec.failed, TASK_TEXT_MAX)
    };
}

/**
 * Lance une opération et la suit. La promesse se résout et rejette comme `run`,
 * sauf quand la commande n'a pas pu partir ou que le serveur n'en garde plus
 * trace, où elle rejette une `TaskError` qui porte la bonne phrase.
 */
export function startTask<T>(spec: TaskSpec<T>, run: (task: TaskContext) => Promise<T>): Promise<T> {
    if (spec.key !== undefined && records.some((r) => r.state === 'running' && sameTarget(r, spec))) {
        return Promise.reject(new TaskError('conflict', CONFLICT_NOTE));
    }

    const id = randomUuid();
    const tag = tagOf(id, spec);
    handles.set(id, {
        cancel: spec.cancel,
        onDetach: spec.onDetach,
        cancelRequested: false,
        progressAt: 0,
        pending: null,
        timer: null,
        snapshot: null,
        epoch: epochs.get(spec.origin.instanceId)
    });
    publish([
        ...records,
        {
            id,
            feature: spec.feature,
            itemId: spec.itemId,
            key: spec.key,
            title: spec.title,
            subject: spec.subject,
            description: spec.description,
            origin: spec.origin,
            startedAt: Date.now(),
            state: 'running',
            local: spec.local,
            minimizable: spec.minimizable,
            cancellable: spec.cancel !== undefined,
            foreground: spec.dialog,
            detached: !spec.dialog && spec.inPlace !== true,
            raisedAt: ++raiseSeq,
            seen: false,
            owned: true,
            tracked: tag !== undefined
        }
    ]);

    const context: TaskContext = {
        id,
        origin: spec.origin,
        sendOptions: {
            timeoutMs: SILENCE_MS,
            onProgress: ({ done, total, step }) =>
                progress(id, {
                    value: total !== undefined && total > 0 ? Math.min(1, (done ?? 0) / total) : undefined,
                    step: stepOf(step, done, total)
                }),
            ...(spec.origin.workspaceId !== null ? { workspaceId: spec.origin.workspaceId } : {}),
            ...(tag ? { task: tag } : {})
        },
        report: ({ value, step }) => {
            const change: Partial<TaskRecord> = {};
            if (value !== undefined) change.value = value === null ? undefined : Math.min(1, Math.max(0, value));
            if (step !== undefined) change.step = step === null ? undefined : step;
            progress(id, change);
        },
        raise: () => raiseTask(id)
    };

    let work: Promise<T>;
    try {
        work = run(context);
    } catch (e) {
        work = Promise.reject(e instanceof Error ? e : new Error(String(e)));
    }
    return work.then(
        (result) => {
            succeed(id, spec, result);
            return result;
        },
        (error: unknown) => {
            throw fail(id, spec, error);
        }
    );
}

/** Réduit le dialogue d'une opération : elle passe dans la zone, pour de bon. */
export function minimizeTask(id: string): void {
    const record = find(id);
    if (!record || record.state !== 'running' || !record.foreground || !record.minimizable) return;
    const first = !record.detached;
    patch(id, { foreground: false, detached: true });
    if (first) handles.get(id)?.onDetach?.();
}

/** L'écran qui dessinait l'attente s'en va : l'opération passe dans la zone, pour de bon. */
export function detachTask(id: string): void {
    const record = find(id);
    if (!record || record.state !== 'running' || record.detached) return;
    patch(id, { foreground: false, detached: true });
    handles.get(id)?.onDetach?.();
}

/** Ramène devant le dialogue d'une opération en cours que cette page a lancée. */
export function raiseTask(id: string): void {
    const record = find(id);
    if (!record || record.state !== 'running' || !record.owned) return;
    patch(id, { foreground: true, raisedAt: ++raiseSeq });
}

/**
 * Demande l'abandon. Une opération de cette page sort quand son travail
 * rejette ; celle qu'un service mène, quand il s'est arrêté.
 */
export function cancelTask(id: string): void {
    const record = find(id);
    const handle = handles.get(id);
    if (record && record.state === 'running' && !record.owned && record.cancellable) {
        patch(id, { cancellable: false, step: CANCELLING_STEP });
        remote?.cancel(record.origin.instanceId, id);
        return;
    }
    if (!record || record.state !== 'running' || !handle?.cancel || handle.cancelRequested) return;
    handle.cancelRequested = true;
    handle.pending = null;
    patch(id, { cancellable: false, step: CANCELLING_STEP });
    handle.cancel();
}

/**
 * Retire une opération de la zone : un résultat, ou une opération en cours que
 * cette page n'a pas lancée et qu'elle cesse de suivre.
 */
export function dismissTask(id: string): void {
    const record = find(id);
    if (!record || (record.state === 'running' && record.owned)) return;
    discard([record]);
}

export function clearFinished(): void {
    discard(records.filter((r) => r.state !== 'running'));
}

/**
 * Le panneau s'ouvre ou se ferme. Un succès qu'il a montré part à sa fermeture ;
 * un échec ou une perte restent jusqu'à leur croix.
 */
export function setPanelOpen(open: boolean): void {
    if (panelOpen === open) return;
    panelOpen = open;
    if (open) {
        if (records.some((r) => r.state === 'done' && !r.seen)) {
            publish(records.map((r) => (r.state === 'done' ? { ...r, seen: true } : r)));
        }
    } else {
        discard(records.filter((r) => r.state === 'done' && r.seen));
    }
}

/** Fin de session : la zone se vide, et le travail local qui sait s'arrêter s'arrête. */
export function resetTasks(): void {
    for (const record of records) {
        if (record.state === 'running' && record.local) handles.get(record.id)?.cancel?.();
    }
    for (const id of [...handles.keys()]) release(id);
    epochs.clear();
    panelOpen = false;
    if (records.length > 0) publish([]);
}

/** La session d'une instance distante se ferme : ce qu'on y suivait n'a plus de source. */
export function forgetInstanceTasks(instanceId: number | null): void {
    epochs.delete(instanceId);
    const next = records.filter((r) => r.owned || r.origin.instanceId !== instanceId);
    if (next.length !== records.length) publish(next);
}

// ── Ce que le serveur dit des opérations du compte ─────────────────────────

function failureOf(snapshot: TaskSnapshot): ErrorNoteInput {
    return {
        message: humanizeError(snapshot.error, snapshot.failed ?? FAILED_NOTE),
        code: snapshot.error?.code ?? null
    };
}

/** La ligne d'une opération que cette page n'a pas lancée, telle que le serveur la décrit. */
function followed(instanceId: number | null, snapshot: TaskSnapshot, previous: TaskRecord | undefined): TaskRecord {
    const running = snapshot.state === 'running';
    const { done, total, step } = snapshot.progress ?? {};
    return {
        id: snapshot.id,
        feature: snapshot.feature ?? '',
        itemId: snapshot.itemId ?? undefined,
        key: snapshot.key ?? undefined,
        title: snapshot.title,
        subject: snapshot.subject ?? undefined,
        origin: { instanceId, workspaceId: snapshot.workspaceId },
        startedAt: snapshot.startedAt,
        state: snapshot.state,
        endedAt: snapshot.endedAt ?? undefined,
        value: running && total !== undefined && total > 0 ? Math.min(1, (done ?? 0) / total) : undefined,
        step: running ? stepOf(step, done, total) : undefined,
        note: snapshot.state === 'done' ? (snapshot.done ?? DONE_NOTE) : undefined,
        error: snapshot.state === 'failed' ? failureOf(snapshot) : undefined,
        local: false,
        minimizable: false,
        cancellable: running && snapshot.cancellable,
        foreground: false,
        detached: true,
        raisedAt: 0,
        seen: previous !== undefined && previous.state !== 'running' ? previous.seen : !running && panelOpen,
        owned: false,
        tracked: true
    };
}

function merge(list: readonly TaskRecord[], instanceId: number | null, snapshot: TaskSnapshot): readonly TaskRecord[] {
    // La requête en vol de cette page décidera : ce que dit le serveur est gardé pour le cas où elle se perd.
    const handle = handles.get(snapshot.id);
    if (handle) {
        handle.snapshot = snapshot;
        return list;
    }
    const previous = list.find((r) => r.id === snapshot.id);
    // Le résultat qu'une page a vu arriver fait foi, sauf quand elle l'a perdu.
    if (previous?.owned && previous.state !== 'lost') return list;
    const next = followed(instanceId, snapshot, previous);
    return previous ? list.map((r) => (r === previous ? next : r)) : [...list, next];
}

/** Une opération du compte est apparue, a avancé ou s'est terminée ailleurs. */
export function applyTaskUpdate(instanceId: number | null, snapshot: TaskSnapshot): void {
    const next = merge(records, instanceId, snapshot);
    if (next !== records) publish(next);
}

/** Des opérations ont été retirées de la zone du compte ; celles que cette page attend encore y restent. */
export function applyTaskRemoved(instanceId: number | null, ids: readonly string[]): void {
    const gone = new Set(ids);
    const next = records.filter((r) => !gone.has(r.id) || r.origin.instanceId !== instanceId || handles.has(r.id));
    if (next.length !== records.length) publish(next);
}

/**
 * La liste que le serveur d'une instance donne à l'ouverture de sa socket. Une
 * opération suivie qu'elle ne cite plus a été retirée ailleurs pendant la
 * coupure ; si l'époque a changé, le serveur a redémarré et ne sait plus rien.
 */
export function applyTaskRoster(instanceId: number | null, roster: TaskRoster): void {
    const before = epochs.get(instanceId);
    epochs.set(instanceId, roster.epoch);
    const restarted = before !== undefined && before !== roster.epoch;
    const listed = new Set(roster.list.map((snapshot) => snapshot.id));

    let changed = false;
    let next: readonly TaskRecord[] = records.flatMap((record): TaskRecord[] => {
        const stale =
            record.origin.instanceId === instanceId &&
            record.tracked &&
            !listed.has(record.id) &&
            !handles.has(record.id);
        if (!stale || (record.owned && !restarted)) return [record];
        changed = true;
        if (!restarted) return [];
        if (record.state !== 'running') return [{ ...record, tracked: false }];
        return [
            {
                ...record,
                state: 'lost',
                endedAt: Date.now(),
                value: undefined,
                step: undefined,
                error: { message: RESTART_NOTE, code: 'lost' },
                seen: false,
                tracked: false
            }
        ];
    });
    if (!changed) next = records;
    for (const snapshot of roster.list) next = merge(next, instanceId, snapshot);
    if (next !== records) publish(next);
}

// ── Lectures ───────────────────────────────────────────────────────────────

/** L'opération dont le dialogue est à l'écran : la dernière ramenée devant. */
export function foregroundOf(list: readonly TaskRecord[]): TaskRecord | null {
    let front: TaskRecord | null = null;
    for (const record of list) {
        if (record.state !== 'running' || !record.foreground) continue;
        if (front === null || record.raisedAt > front.raisedAt) front = record;
    }
    return front;
}

/** Ce que la zone montre : les opérations détachées, la plus récente d'abord. */
export function zoneOf(list: readonly TaskRecord[]): readonly TaskRecord[] {
    return list.filter((r) => r.detached).sort((a, b) => b.startedAt - a.startedAt);
}

export interface ChipView {
    tone: 'running' | 'failed' | 'lost' | 'done';
    /** Combien d'opérations sont dans l'état que le ton montre. */
    count: number;
    /** L'avancement, quand une seule opération mesurée tourne. */
    value?: number;
    /** Un échec ou une perte attend pendant que d'autres tournent. */
    alert: 'failed' | 'lost' | null;
}

/** L'état de la puce, `null` quand la zone est vide. */
export function chipOf(list: readonly TaskRecord[]): ChipView | null {
    const zone = zoneOf(list);
    if (zone.length === 0) return null;
    const count = (state: TaskState): number => zone.filter((r) => r.state === state).length;
    const running = zone.filter((r) => r.state === 'running');
    const failed = count('failed');
    const lost = count('lost');
    if (running.length > 0) {
        return {
            tone: 'running',
            count: running.length,
            value: running.length === 1 ? running[0].value : undefined,
            alert: failed > 0 ? 'failed' : lost > 0 ? 'lost' : null
        };
    }
    // Le compte est celui du ton montré : un échec parmi des succès reste un échec.
    if (failed > 0) return { tone: 'failed', count: failed, alert: null };
    if (lost > 0) return { tone: 'lost', count: lost, alert: null };
    return { tone: 'done', count: count('done'), alert: null };
}

/** Les opérations en cours d'une fonctionnalité dans un espace, qui que soit l'écran qui les a lancées. */
export function matchRunning(
    list: readonly TaskRecord[],
    filter: { feature: string; itemId?: string | number; key?: string },
    origin: TaskOrigin
): readonly Task[] {
    const itemId = filter.itemId === undefined ? undefined : String(filter.itemId);
    return list.filter(
        (r) =>
            r.state === 'running' &&
            r.feature === filter.feature &&
            (itemId === undefined || r.itemId === itemId) &&
            (filter.key === undefined || r.key === filter.key) &&
            r.origin.instanceId === origin.instanceId &&
            r.origin.workspaceId === origin.workspaceId
    );
}

/** Un travail tourne dans cet onglet : le fermer ou le recharger le perdrait. */
export function hasLocalWork(list: readonly TaskRecord[] = records): boolean {
    return list.some((r) => r.state === 'running' && r.local);
}

export function getTaskRecords(): readonly TaskRecord[] {
    return records;
}

export function onTasksChange(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function useTaskRecords(): readonly TaskRecord[] {
    return useSyncExternalStore(onTasksChange, getTaskRecords, getTaskRecords);
}
