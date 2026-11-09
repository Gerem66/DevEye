import {
    errorNote,
    invalidate,
    onLiveCursors,
    onServerEvent,
    onSocketOpen,
    randomUuid,
    type ErrorNoteInput
} from 'deveye-sdk-client';
import { useEffect, useMemo, useSyncExternalStore } from 'react';

import {
    appearanceFrameSchema,
    closedFrameSchema,
    elementsFrameSchema,
    ELEMENT_MAX_CHARS,
    fileFrameSchema,
    peersFrameSchema,
    presenceFrameSchema,
    PUSH_MAX_ELEMENTS,
    savedFrameSchema,
    WHITEBOARD_APPEARANCE_EVENT,
    WHITEBOARD_CLOSED_EVENT,
    WHITEBOARD_ELEMENTS_EVENT,
    WHITEBOARD_FILE_EVENT,
    WHITEBOARD_PEERS_EVENT,
    WHITEBOARD_PRESENCE_EVENT,
    WHITEBOARD_SAVED_EVENT,
    type BoardAppearance,
    type BoardFile,
    type SceneElement,
    type WhiteboardFileMime,
    type WhiteboardPeer,
    type WhiteboardPresence
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

export interface RemotePeer extends WhiteboardPeer, WhiteboardPresence {
    /** Sa dernière position dans la scène, celle de son curseur DevEye. */
    pointer: { x: number; y: number } | null;
}

export type SessionStatus = 'joining' | 'synced' | 'sending' | 'offline' | 'quota' | 'tooLarge' | 'saveFailed';

export interface SessionView {
    status: SessionStatus;
    /** La scène de la première entrée : l'éditeur s'ouvre dessus. */
    initial: { elements: SceneElement[]; title: string } | null;
    canWrite: boolean;
    appearance: BoardAppearance;
    /** Le canal des curseurs, une fois la séance rejointe sur cette socket. */
    channel: string | null;
    /** Les autres participants. */
    peers: readonly WhiteboardPeer[];
    closed: 'removed' | 'moved' | null;
    error: ErrorNoteInput | null;
}

const PRESENCE_MS = 100;
const PUSH_MS = 100;
/** Bien sous les 20 s au bout desquelles le serveur oublie un participant muet. */
const HEARTBEAT_MS = 8_000;
const REJOIN_FLOOR_MS = 2_000;
/** Temps sans envoi avant d'afficher « Enregistré » : l'état ne clignote pas au fil d'un geste. */
const QUIET_MS = 1_000;

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
        appearance: { background: null, theme: null },
        channel: null,
        peers: [],
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
    private readonly remote = new Map<string, WhiteboardPeer & WhiteboardPresence>();
    /** Les positions reçues du canal, par connexion. */
    private readonly positions = new Map<string, { x: number; y: number }>();
    private stopCursors: (() => void) | null = null;
    private pushing = false;
    private joining: Promise<void> | null = null;
    private lastJoinAt = 0;
    private collaboratorsFrame: number | null = null;
    private settleTimer: ReturnType<typeof setTimeout> | null = null;
    private presence: WhiteboardPresence = { selectedIds: [], laser: false };
    private readonly pushes = throttle(() => void this.pump(), PUSH_MS);
    private readonly presences = throttle(() => this.sendPresence(), PRESENCE_MS);
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
        const heartbeat = setInterval(() => this.sendPresence(), HEARTBEAT_MS);
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
                WHITEBOARD_PRESENCE_EVENT,
                presenceFrameSchema,
                mine((f) => this.onPresence(f))
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
                WHITEBOARD_APPEARANCE_EVENT,
                appearanceFrameSchema,
                mine((f) => this.set({ appearance: { background: f.background, theme: f.theme } }))
            ),
            onServerEvent(
                WHITEBOARD_CLOSED_EVENT,
                closedFrameSchema,
                mine((f) => this.set({ closed: f.reason }))
            ),
            onSocketOpen(() => {
                // Le laissez-passer du canal tenait à l'ancienne socket : la surface attend la nouvelle entrée.
                this.set({ channel: null });
                void this.join();
            }),
            () => clearInterval(heartbeat),
            () => window.removeEventListener('beforeunload', onBeforeUnload),
            () => document.removeEventListener('visibilitychange', onVisible)
        ];
    }

    /** Ce qui restait à envoyer part, puis la séance est quittée. */
    stop(): void {
        for (const stop of this.stops) stop();
        this.stops = [];
        this.stopCursors?.();
        this.stopCursors = null;
        this.presences.cancel();
        this.pushes.cancel();
        if (this.collaboratorsFrame !== null) cancelAnimationFrame(this.collaboratorsFrame);
        if (this.settleTimer !== null) clearTimeout(this.settleTimer);
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

    selection(ids: string[]): void {
        if (ids.join() === this.presence.selectedIds.join()) return;
        this.presence = { ...this.presence, selectedIds: ids };
        this.presences.schedule();
    }

    laser(on: boolean): void {
        if (on === this.presence.laser) return;
        this.presence = { ...this.presence, laser: on };
        this.presences.schedule();
    }

    /** Le fond ou le thème change ici : appliqué tout de suite, défait sur refus. */
    setAppearance(patch: Partial<BoardAppearance>): void {
        if (!this.view.canWrite) return;
        const before = this.view.appearance;
        this.set({ appearance: { ...before, ...patch } });
        api.send('whiteboard.setAppearance', { boardId: this.boardId, ...patch })
            .then(() => invalidate('whiteboard.list'))
            .catch((e: unknown) =>
                this.set({
                    appearance: before,
                    error: errorNote(e, 'L’apparence du tableau n’a pas pu être enregistrée.')
                })
            );
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
                this.watchCursors(res.channel);
                this.set({
                    status: res.overQuota ? 'quota' : 'synced',
                    initial: this.view.initial ?? { elements: res.elements, title: res.title },
                    canWrite: res.canWrite,
                    appearance: res.appearance,
                    channel: res.channel,
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

    private onPresence(frame: { clientId: string } & WhiteboardPresence): void {
        const known = this.remote.get(frame.clientId);
        if (!known) return;
        this.remote.set(frame.clientId, { ...known, selectedIds: frame.selectedIds, laser: frame.laser });
        this.publishPeers();
    }

    /** Les positions du canal ne passent à l'éditeur que pendant un laser : il n'en dessine que la traînée. */
    private watchCursors(channel: string | null): void {
        this.stopCursors?.();
        this.stopCursors =
            channel === null
                ? null
                : onLiveCursors(channel, (cursors) => {
                      this.positions.clear();
                      for (const { connId, cursor } of cursors)
                          this.positions.set(connId, { x: cursor.x, y: cursor.y });
                      if ([...this.remote.values()].some((peer) => peer.laser)) this.publishPeers();
                  });
    }

    private onPeers(peers: readonly WhiteboardPeer[]): void {
        const others = peers.filter((p) => p.clientId !== this.clientId);
        const next = new Map<string, WhiteboardPeer & WhiteboardPresence>();
        for (const peer of others) {
            const known = this.remote.get(peer.clientId);
            next.set(peer.clientId, {
                ...peer,
                selectedIds: known?.selectedIds ?? [],
                laser: known?.laser ?? false
            });
        }
        this.remote.clear();
        for (const [id, peer] of next) this.remote.set(id, peer);
        this.set({ peers: others });
        this.publishPeers();
    }

    private onSaved(failure: 'tooLarge' | 'error' | null): void {
        if (failure === 'tooLarge') this.set({ status: 'tooLarge' });
        else if (failure === 'error') this.set({ status: 'saveFailed' });
        else if (this.view.status === 'tooLarge' || this.view.status === 'saveFailed') {
            this.set({ status: this.pending() ? 'sending' : 'synced' });
        }
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
            this.bridge?.peers(
                [...this.remote.values()].map((peer) => ({
                    ...peer,
                    pointer: peer.connId === null ? null : (this.positions.get(peer.connId) ?? null)
                }))
            );
        });
    }

    private sendPresence(): void {
        if (this.view.initial === null || this.view.closed !== null) return;
        api.post('whiteboard.presence', {
            boardId: this.boardId,
            clientId: this.clientId,
            selectedIds: this.presence.selectedIds.slice(0, PUSH_MAX_ELEMENTS),
            laser: this.presence.laser
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
            else {
                if (this.view.status === 'offline') this.set({ status: 'sending' });
                if (this.view.status === 'sending') this.settleLater();
            }
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

    private settleLater(): void {
        if (this.settleTimer !== null) clearTimeout(this.settleTimer);
        this.settleTimer = setTimeout(() => {
            this.settleTimer = null;
            if (this.view.status === 'sending' && !this.pending()) this.set({ status: 'synced' });
        }, QUIET_MS);
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
