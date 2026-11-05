import { errorNote, onServerEvent, onSocketOpen, randomUuid, type ErrorNoteInput } from 'deveye-sdk-client';
import { useEffect, useMemo, useSyncExternalStore } from 'react';

import {
    closedFrameSchema,
    elementsFrameSchema,
    ELEMENT_MAX_CHARS,
    fileFrameSchema,
    peersFrameSchema,
    pointersFrameSchema,
    PUSH_MAX_ELEMENTS,
    savedFrameSchema,
    WHITEBOARD_CLOSED_EVENT,
    WHITEBOARD_ELEMENTS_EVENT,
    WHITEBOARD_FILE_EVENT,
    WHITEBOARD_PEERS_EVENT,
    WHITEBOARD_POINTERS_EVENT,
    WHITEBOARD_SAVED_EVENT,
    type BoardFile,
    type SceneElement,
    type WhiteboardFileMime,
    type WhiteboardPeer,
    type WhiteboardPointer
} from '../contracts/domain';
import { api } from './api';
import { DeltaTracker } from './sync/delta';
import { gate } from './sync/seqGate';
import { throttle } from './sync/throttle';

/** Ce que la séance demande à l'éditeur, sans rien importer d'Excalidraw. */
export interface SceneBridge {
    /** Tous les éléments, supprimés compris. */
    elements(): readonly SceneElement[];
    /** Fusionne des éléments venus d'ailleurs, hors de l'historique d'annulation. */
    merge(remote: readonly SceneElement[]): void;
    peers(peers: readonly RemotePeer[]): void;
    file(id: string): { mimeType: string; dataURL: string } | null;
    addFiles(files: readonly BoardFile[]): void;
}

export interface RemotePeer extends WhiteboardPeer {
    pointer: WhiteboardPointer | null;
    button: 'up' | 'down';
    selectedIds: readonly string[];
}

export type SessionStatus = 'joining' | 'synced' | 'sending' | 'offline' | 'quota' | 'tooLarge' | 'saveFailed';

export interface SessionView {
    status: SessionStatus;
    /** La scène de la première entrée : l'éditeur s'ouvre dessus. */
    initial: { elements: SceneElement[]; title: string } | null;
    canWrite: boolean;
    closed: 'removed' | 'moved' | null;
    error: ErrorNoteInput | null;
}

const POINTER_MS = 80;
const PUSH_MS = 100;
/** Bien sous les 20 s au bout desquelles le serveur oublie un participant muet. */
const HEARTBEAT_MS = 8_000;
const REJOIN_FLOOR_MS = 2_000;

/**
 * Un tableau ouvert, côté navigateur : l'entrée dans la séance, l'envoi de ce
 * qui change ici, l'application de ce qui change ailleurs, et la reprise après
 * une trame perdue ou une coupure. Le serveur fait autorité.
 */
export class BoardSession {
    readonly clientId = randomUuid();
    private view: SessionView = {
        status: 'joining',
        initial: null,
        canWrite: false,
        closed: null,
        error: null
    };
    private readonly listeners = new Set<() => void>();
    private readonly tracker = new DeltaTracker();
    private bridge: SceneBridge | null = null;
    private pendingRemote: SceneElement[] = [];
    private lastSeq = 0;
    private serverFiles = new Set<string>();
    private readonly fetching = new Set<string>();
    private readonly uploading = new Set<string>();
    private readonly unsent = new Set<string>();
    private readonly remote = new Map<string, RemotePeer>();
    private pushing = false;
    private joining: Promise<void> | null = null;
    private lastJoinAt = 0;
    private collaboratorsFrame: number | null = null;
    private pointerState: { pointer: WhiteboardPointer | null; button: 'up' | 'down'; selectedIds: string[] } = {
        pointer: null,
        button: 'up',
        selectedIds: []
    };
    private readonly pushes = throttle(() => void this.pump(), PUSH_MS);
    private readonly pointers = throttle(() => this.sendPointer(), POINTER_MS);
    private stops: (() => void)[] = [];

    constructor(readonly boardId: number) {}

    readonly subscribe = (listener: () => void): (() => void) => {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    };

    readonly snapshot = (): SessionView => this.view;

    start(): void {
        if (this.stops.length > 0) return;
        const mine =
            <T extends { boardId: number }>(cb: (frame: T) => void) =>
            (frame: T) => {
                if (frame.boardId === this.boardId) cb(frame);
            };
        const heartbeat = setInterval(() => this.sendPointer(), HEARTBEAT_MS);
        const onBeforeUnload = (e: BeforeUnloadEvent) => {
            if (this.pending()) e.preventDefault();
        };
        const onVisible = () => {
            if (document.visibilityState === 'visible') void this.join();
        };
        window.addEventListener('beforeunload', onBeforeUnload);
        document.addEventListener('visibilitychange', onVisible);
        this.stops = [
            onServerEvent(
                WHITEBOARD_ELEMENTS_EVENT,
                elementsFrameSchema,
                mine((f) => this.onElements(f))
            ),
            onServerEvent(
                WHITEBOARD_POINTERS_EVENT,
                pointersFrameSchema,
                mine((f) => this.onPointer(f))
            ),
            onServerEvent(
                WHITEBOARD_PEERS_EVENT,
                peersFrameSchema,
                mine((f) => this.onPeers(f.peers))
            ),
            onServerEvent(
                WHITEBOARD_SAVED_EVENT,
                savedFrameSchema,
                mine((f) => this.onSaved(f.failure))
            ),
            onServerEvent(
                WHITEBOARD_FILE_EVENT,
                fileFrameSchema,
                mine((f) => this.onFile(f.fileId))
            ),
            onServerEvent(
                WHITEBOARD_CLOSED_EVENT,
                closedFrameSchema,
                mine((f) => this.set({ closed: f.reason }))
            ),
            onSocketOpen(() => void this.join()),
            () => clearInterval(heartbeat),
            () => window.removeEventListener('beforeunload', onBeforeUnload),
            () => document.removeEventListener('visibilitychange', onVisible)
        ];
    }

    /** Ce qui restait à envoyer part, puis la séance est quittée. */
    stop(): void {
        for (const stop of this.stops) stop();
        this.stops = [];
        this.pointers.cancel();
        this.pushes.cancel();
        if (this.collaboratorsFrame !== null) cancelAnimationFrame(this.collaboratorsFrame);
        void this.pump().finally(() => {
            api.send('whiteboard.leave', { boardId: this.boardId, clientId: this.clientId }).catch(() => undefined);
        });
    }

    /** L'éditeur est prêt (ou démonté) : ce qui est arrivé entre-temps s'y applique. */
    bind(bridge: SceneBridge | null): void {
        this.bridge = bridge;
        if (bridge === null) return;
        if (this.pendingRemote.length > 0) {
            bridge.merge(this.pendingRemote);
            this.pendingRemote = [];
        }
        this.publishPeers();
        this.requestFiles(bridge.elements());
    }

    /** La scène a changé ici. */
    changed(): void {
        if (this.view.canWrite) this.pushes.schedule();
    }

    pointer(pointer: WhiteboardPointer, button: 'up' | 'down'): void {
        this.pointerState = { ...this.pointerState, pointer, button };
        this.pointers.schedule();
    }

    selection(ids: string[]): void {
        if (ids.join() === this.pointerState.selectedIds.join()) return;
        this.pointerState = { ...this.pointerState, selectedIds: ids };
        this.pointers.schedule();
    }

    /** Quelque chose attend de partir : quitter la page le perdrait. */
    pending(): boolean {
        if (this.pushing) return true;
        if (this.bridge === null || !this.view.canWrite) return false;
        return this.tracker.diff(this.bridge.elements(), 1).length > 0;
    }

    // ── Interne ────────────────────────────────────────────────────────────

    private set(patch: Partial<SessionView>): void {
        this.view = { ...this.view, ...patch };
        for (const listener of this.listeners) listener();
    }

    private join(): Promise<void> {
        if (this.joining) return this.joining;
        if (this.view.closed !== null) return Promise.resolve();
        const wait = Math.max(0, this.lastJoinAt + REJOIN_FLOOR_MS - Date.now());
        this.joining = (async () => {
            if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
            this.lastJoinAt = Date.now();
            try {
                const res = await api.send(
                    'whiteboard.join',
                    { boardId: this.boardId, clientId: this.clientId },
                    { timeoutMs: 30_000 }
                );
                this.lastSeq = res.seq;
                this.serverFiles = new Set(res.fileIds);
                if (this.bridge) this.bridge.merge(res.elements);
                else if (this.view.initial !== null) this.pendingRemote = res.elements;
                this.tracker.reset(res.elements);
                this.onPeers(res.peers);
                this.set({
                    status: res.overQuota ? 'quota' : 'synced',
                    initial: this.view.initial ?? { elements: res.elements, title: res.title },
                    canWrite: res.canWrite,
                    error: null
                });
                // Ce qui a été dessiné hors ligne part maintenant.
                if (this.bridge) {
                    this.requestFiles(this.bridge.elements());
                    this.pushes.schedule();
                }
            } catch (e) {
                const code = (e as { code?: string }).code;
                if (code === 'not_found' || code === 'forbidden') this.set({ closed: 'removed' });
                else this.set({ status: 'offline', error: errorNote(e, 'Le tableau n’a pas pu être ouvert.') });
            } finally {
                this.joining = null;
            }
        })();
        return this.joining;
    }

    private onElements(frame: { seq: number; from: string; elements: SceneElement[] }): void {
        const verdict = gate(this.lastSeq, frame.seq);
        if (verdict === 'stale') return;
        if (verdict === 'gap') {
            void this.join();
            return;
        }
        this.lastSeq = frame.seq;
        if (frame.from === this.clientId) return;
        this.tracker.received(frame.elements);
        if (this.bridge) {
            this.bridge.merge(frame.elements);
            this.requestFiles(frame.elements);
        } else this.pendingRemote.push(...frame.elements);
    }

    private onPointer(frame: {
        clientId: string;
        pointer: WhiteboardPointer | null;
        button: 'up' | 'down';
        selectedIds: string[];
    }): void {
        const known = this.remote.get(frame.clientId);
        if (!known) return;
        this.remote.set(frame.clientId, {
            ...known,
            pointer: frame.pointer,
            button: frame.button,
            selectedIds: frame.selectedIds
        });
        this.publishPeers();
    }

    private onPeers(peers: readonly WhiteboardPeer[]): void {
        const others = peers.filter((p) => p.clientId !== this.clientId);
        const next = new Map<string, RemotePeer>();
        for (const peer of others) {
            const known = this.remote.get(peer.clientId);
            next.set(peer.clientId, {
                ...peer,
                pointer: known?.pointer ?? null,
                button: known?.button ?? 'up',
                selectedIds: known?.selectedIds ?? []
            });
        }
        this.remote.clear();
        for (const [id, peer] of next) this.remote.set(id, peer);
        this.publishPeers();
    }

    private onSaved(failure: 'tooLarge' | 'error' | null): void {
        if (failure === 'tooLarge') this.set({ status: 'tooLarge' });
        else if (failure === 'error') this.set({ status: 'saveFailed' });
        else if (this.view.status !== 'quota') this.set({ status: this.pushing ? 'sending' : 'synced' });
    }

    private onFile(fileId: string): void {
        this.serverFiles.add(fileId);
        if (this.bridge) this.requestFiles(this.bridge.elements());
    }

    /** Une image par trame d'animation au plus : les pointeurs arrivent par dizaines. */
    private publishPeers(): void {
        if (this.collaboratorsFrame !== null || this.bridge === null) return;
        this.collaboratorsFrame = requestAnimationFrame(() => {
            this.collaboratorsFrame = null;
            this.bridge?.peers([...this.remote.values()]);
        });
    }

    private sendPointer(): void {
        if (this.view.initial === null || this.view.closed !== null) return;
        api.post('whiteboard.pointer', {
            boardId: this.boardId,
            clientId: this.clientId,
            pointer: this.pointerState.pointer,
            button: this.pointerState.button,
            selectedIds: this.pointerState.selectedIds.slice(0, PUSH_MAX_ELEMENTS)
        });
    }

    private async pump(): Promise<void> {
        const bridge = this.bridge;
        if (this.pushing || bridge === null || !this.view.canWrite || this.view.closed !== null) return;
        const batch = this.tracker
            .diff(bridge.elements(), PUSH_MAX_ELEMENTS)
            .filter((el) => JSON.stringify(el).length < ELEMENT_MAX_CHARS);
        if (batch.length === 0) {
            await this.uploadFiles();
            return;
        }
        this.pushing = true;
        this.tracker.sending(batch);
        if (this.view.status === 'synced') this.set({ status: 'sending' });
        try {
            const res = await api.send(
                'whiteboard.push',
                { boardId: this.boardId, clientId: this.clientId, elements: batch },
                { timeoutMs: 30_000 }
            );
            this.tracker.sent(batch);
            if (res.refused !== null) this.set({ status: res.refused });
            else if (this.view.status === 'sending' || this.view.status === 'offline') this.set({ status: 'synced' });
        } catch (e) {
            this.tracker.failed(batch);
            if ((e as { code?: string }).code === 'conflict') void this.join();
            else this.set({ status: 'offline' });
        } finally {
            this.pushing = false;
        }
        if (this.tracker.diff(bridge.elements(), 1).length > 0) this.pushes.schedule();
        await this.uploadFiles();
    }

    /** Les images de la scène que le serveur n'a pas encore, une à la fois. */
    private async uploadFiles(): Promise<void> {
        const bridge = this.bridge;
        if (bridge === null || !this.view.canWrite) return;
        for (const fileId of fileIdsOf(bridge.elements())) {
            if (this.serverFiles.has(fileId) || this.uploading.has(fileId) || this.unsent.has(fileId)) continue;
            const file = bridge.file(fileId);
            if (file === null) continue;
            this.uploading.add(fileId);
            try {
                await api.send(
                    'whiteboard.fileAdd',
                    {
                        boardId: this.boardId,
                        fileId,
                        mimeType: file.mimeType as WhiteboardFileMime,
                        dataURL: file.dataURL
                    },
                    { timeoutMs: 120_000 }
                );
                this.serverFiles.add(fileId);
            } catch (e) {
                // Refusée (offre pleine, format) : elle reste ici sans repartir à chaque trait.
                this.unsent.add(fileId);
                this.set({ error: errorNote(e, 'Une image n’a pas pu être enregistrée.') });
            } finally {
                this.uploading.delete(fileId);
            }
        }
    }

    /** Les images montrées que l'éditeur n'a pas, demandées par lots. */
    private requestFiles(elements: readonly SceneElement[]): void {
        const bridge = this.bridge;
        if (bridge === null) return;
        const wanted = fileIdsOf(elements).filter(
            (id) => this.serverFiles.has(id) && !this.fetching.has(id) && bridge.file(id) === null
        );
        if (wanted.length === 0) return;
        for (const id of wanted) this.fetching.add(id);
        void (async () => {
            let ask = wanted;
            try {
                while (ask.length > 0) {
                    const res = await api.send(
                        'whiteboard.files',
                        { boardId: this.boardId, fileIds: ask },
                        { timeoutMs: 60_000 }
                    );
                    if (res.files.length > 0) this.bridge?.addFiles(res.files);
                    ask = res.more;
                }
            } catch {
                // Une image absente reste un cadre vide : rien d'autre ne casse.
            } finally {
                for (const id of wanted) this.fetching.delete(id);
            }
        })();
    }
}

function fileIdsOf(elements: readonly SceneElement[]): string[] {
    const ids = new Set<string>();
    for (const el of elements) {
        if (!el.isDeleted && el.type === 'image' && typeof el.fileId === 'string') ids.add(el.fileId);
    }
    return [...ids];
}

/** La séance d'un tableau, le temps que l'éditeur est monté. */
export function useBoardSession(boardId: number): [SessionView, BoardSession] {
    const session = useMemo(() => new BoardSession(boardId), [boardId]);
    const view = useSyncExternalStore(session.subscribe, session.snapshot, session.snapshot);
    useEffect(() => {
        session.start();
        return () => session.stop();
    }, [session]);
    return [view, session];
}
