import { useSyncExternalStore } from 'react';

import type { SendOptions } from '@/api/ws';
import type { ErrorNoteInput } from '@/Components/ErrorNote';

import { randomUuid } from '../randomUuid';

/**
 * Les opérations longues en cours et leurs résultats : ce que montrent le
 * dialogue réductible, la puce de la barre et son panneau.
 *
 * Sans import de `api/ws` ni de `stores/workspace` : ils lisent l'environnement
 * de Vite au chargement, et ce magasin se teste sous Node.
 */

/** Le silence toléré de la commande d'une opération : chaque avancement relance le compte. */
const SILENCE_MS = 120_000;
/** Au-delà, les opérations finies les plus anciennes cèdent la place. */
const FINISHED_MAX = 30;
/** L'écart minimal entre deux avancements publiés d'une même opération. */
export const PROGRESS_GAP_MS = 100;

export const LOST_NOTE =
    'La connexion a été coupée pendant l’opération. Elle se poursuit sans doute sur le serveur : vérifiez son résultat avant de la relancer.';
export const SILENT_NOTE =
    'Le serveur ne donne plus de nouvelles. L’opération se poursuit peut-être : vérifiez son résultat avant de la relancer.';
const CONFLICT_NOTE = 'Cette opération est déjà en cours.';
const CANCELLED_NOTE = 'Opération annulée.';
const CANCELLING_STEP = 'Annulation…';
const DONE_NOTE = 'Terminé.';

/** `lost` : la socket est tombée, le serveur a sans doute fini sans pouvoir le dire. */
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
    minimizable: boolean;
    local: boolean;
    done?: string | ((result: T) => string);
    failure: (error: unknown) => ErrorNoteInput;
    cancel?: () => void;
    onDetach?: () => void;
}

export interface TaskContext {
    /** À passer à LA commande de l'opération : silence toléré, avancement branché, espace d'origine. */
    sendOptions: SendOptions;
    /** L'avancement d'un travail fait dans l'onglet ; `null` efface la valeur. */
    report(update: { value?: number | null; step?: string | null }): void;
    /** Ramène le dialogue devant, avant une invite qui a besoin de la personne. */
    raise(): void;
    origin: TaskOrigin;
}

export type TaskErrorCode = 'closed' | 'timeout' | 'conflict' | 'cancelled';

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
}

let records: readonly TaskRecord[] = [];
const handles = new Map<string, Handle>();
const listeners = new Set<() => void>();
let panelOpen = false;
let raiseSeq = 0;

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

function remove(id: string): void {
    release(id);
    if (find(id)) publish(records.filter((r) => r.id !== id));
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
    const count = total !== undefined && total > 0 ? `${done ?? 0} sur ${total}` : undefined;
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
    const surplus = new Set(
        [...finished]
            .sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0))
            .slice(0, Math.max(0, finished.length - FINISHED_MAX))
            .map((r) => r.id)
    );
    publish(surplus.size > 0 ? settled.filter((r) => !surplus.has(r.id)) : settled);
}

function succeed<T>(id: string, spec: TaskSpec<T>, result: T): void {
    const record = find(id);
    release(id);
    if (!record) return;
    if (!record.detached) {
        remove(id);
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
    const cancelled = handles.get(id)?.cancelRequested === true;
    release(id);
    if (!record) return error;
    if (cancelled) {
        remove(id);
        return new TaskError('cancelled', CANCELLED_NOTE);
    }

    const code = codeOf(error);
    let thrown: unknown = error;
    let state: TaskState = 'failed';
    let note: ErrorNoteInput;
    // Une commande dont la socket tombe n'a pas échoué : le serveur va au bout.
    // Un travail local, lui, s'arrête vraiment avec sa connexion.
    if (!record.local && code === 'closed') {
        state = 'lost';
        thrown = new TaskError('closed', LOST_NOTE);
        note = { message: LOST_NOTE, code: 'closed' };
    } else if (!record.local && code === 'timeout') {
        thrown = new TaskError('timeout', SILENT_NOTE);
        note = { message: SILENT_NOTE, code: 'timeout' };
    } else {
        note = spec.failure(error);
    }

    if (!record.detached) remove(id);
    else finish(id, { state, error: note });
    return thrown;
}

/**
 * Lance une opération et la suit. La promesse se résout et rejette comme `run`,
 * sauf pour une coupure ou un silence de la commande, où elle rejette une
 * `TaskError` qui porte la bonne phrase.
 */
export function startTask<T>(spec: TaskSpec<T>, run: (task: TaskContext) => Promise<T>): Promise<T> {
    if (spec.key !== undefined && records.some((r) => r.state === 'running' && sameTarget(r, spec))) {
        return Promise.reject(new TaskError('conflict', CONFLICT_NOTE));
    }

    const id = randomUuid();
    handles.set(id, {
        cancel: spec.cancel,
        onDetach: spec.onDetach,
        cancelRequested: false,
        progressAt: 0,
        pending: null,
        timer: null
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
            detached: !spec.dialog,
            raisedAt: ++raiseSeq,
            seen: false
        }
    ]);

    const context: TaskContext = {
        origin: spec.origin,
        sendOptions: {
            timeoutMs: SILENCE_MS,
            onProgress: ({ done, total, step }) =>
                progress(id, {
                    value: total !== undefined && total > 0 ? Math.min(1, (done ?? 0) / total) : undefined,
                    step: stepOf(step, done, total)
                }),
            ...(spec.origin.workspaceId !== null ? { workspaceId: spec.origin.workspaceId } : {})
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

/** Ramène le dialogue d'une opération en cours devant. */
export function raiseTask(id: string): void {
    const record = find(id);
    if (!record || record.state !== 'running') return;
    patch(id, { foreground: true, raisedAt: ++raiseSeq });
}

/** Demande l'abandon : l'opération sort quand son travail rejette. */
export function cancelTask(id: string): void {
    const record = find(id);
    const handle = handles.get(id);
    if (!record || record.state !== 'running' || !handle?.cancel || handle.cancelRequested) return;
    handle.cancelRequested = true;
    handle.pending = null;
    patch(id, { cancellable: false, step: CANCELLING_STEP });
    handle.cancel();
}

/** Retire une opération finie de la zone. */
export function dismissTask(id: string): void {
    const record = find(id);
    if (!record || record.state === 'running') return;
    remove(id);
}

export function clearFinished(): void {
    if (records.some((r) => r.state !== 'running')) publish(records.filter((r) => r.state === 'running'));
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
    } else if (records.some((r) => r.state === 'done' && r.seen)) {
        publish(records.filter((r) => !(r.state === 'done' && r.seen)));
    }
}

/** Fin de session : la zone se vide, et le travail local qui sait s'arrêter s'arrête. */
export function resetTasks(): void {
    for (const record of records) {
        if (record.state === 'running' && record.local) handles.get(record.id)?.cancel?.();
    }
    for (const id of [...handles.keys()]) release(id);
    panelOpen = false;
    if (records.length > 0) publish([]);
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
