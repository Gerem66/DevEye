import { FeatureError, type SdkLogger } from '@deveye/types/sdk/server';
import type { UserColor } from '@deveye/types';

import {
    ELEMENT_MAX_CHARS,
    SCENE_MAX_BYTES,
    SCENE_MAX_ELEMENTS,
    SERVER_ORIGIN,
    WHITEBOARD_APPEARANCE_EVENT,
    WHITEBOARD_CLOSED_EVENT,
    WHITEBOARD_ELEMENTS_EVENT,
    WHITEBOARD_FILE_EVENT,
    WHITEBOARD_PEERS_EVENT,
    WHITEBOARD_PRESENCE_EVENT,
    WHITEBOARD_SAVED_EVENT,
    type BoardAppearance,
    type SceneElement,
    type WhiteboardPeer,
    type WhiteboardPresence
} from '../../contracts/domain';
import { ordered, pruneTombstones, sizeOf, wins } from './merge';

/** Ce que la séance demande au stockage, sans rien savoir du chiffrement. */
export interface StoredScene {
    workspaceId: number;
    version: number;
    elements: SceneElement[];
}

export type SaveResult = { ok: true; version: number } | { ok: false; reason: 'gone' | 'moved' | 'stale' | 'tooLarge' };

export interface SceneStore {
    load(boardId: number): Promise<StoredScene | null>;
    /** Compare-and-set sur `baseVersion`. */
    save(input: {
        boardId: number;
        workspaceId: number;
        baseVersion: number;
        elements: readonly SceneElement[];
        userId: number | null;
    }): Promise<SaveResult>;
    ownerOverQuota(workspaceId: number): Promise<boolean>;
}

export interface SessionsDeps {
    store: SceneStore;
    publishTo(workspaceId: number, userIds: readonly number[], event: string, payload: unknown): void;
    /** La grille des membres se relit : date et aperçu ont bougé. */
    changed(workspaceId: number): void;
    logger: SdkLogger;
    now?(): number;
}

/** Un pair muet ce temps est parti : un onglet tué n'envoie pas de `leave`. */
const PEER_TTL_MS = 20_000;
/** Écriture après ce silence... */
const SAVE_IDLE_MS = 2_000;
/** ... et au moins à cette cadence tant que les traits continuent. */
const SAVE_MAX_DIRTY_MS = 15_000;
/** Une séance vide et écrite reste ce temps en mémoire : rouvrir le tableau ne relit rien. */
const EVICT_AFTER_MS = 5 * 60_000;
const QUOTA_RECHECK_MS = 10 * 60_000;
/** La grille d'un membre relit au plus une fois par minute pendant qu'on dessine. */
const CHANGED_FLOOR_MS = 60_000;
export const MAX_PEERS = 32;
export const MAX_SESSIONS = 200;

interface Peer extends WhiteboardPeer {
    /** La salle de la connexion : un tableau projeté se suit depuis un autre espace. */
    workspaceId: number;
    seenAt: number;
}

interface Session {
    boardId: number;
    home: number;
    elements: Map<string, SceneElement>;
    sizes: Map<string, number>;
    bytes: number;
    version: number;
    seq: number;
    edits: number;
    dirtySince: number | null;
    lastEditAt: number;
    lastUserId: number | null;
    /** Le plafond atteint à la dernière écriture : on ne réessaie qu'après une modification. */
    tooLargeAtEdit: number | null;
    peers: Map<string, Peer>;
    overQuota: boolean;
    quotaCheckedAt: number;
    saving: Promise<void> | null;
    emptySince: number | null;
    changedAt: number;
}

export interface JoinInput {
    boardId: number;
    home: number;
    clientId: string;
    connId: string | null;
    userId: number;
    workspaceId: number;
    name: string;
    color: UserColor;
    canWrite: boolean;
}

export interface PushResult {
    seq: number;
    accepted: number;
    refused: 'quota' | 'tooLarge' | null;
}

/**
 * Les séances des tableaux ouverts, en mémoire de ce processus. Le serveur fait
 * autorité : il fusionne les éléments reçus, numérote ce qu'il rediffuse, et
 * écrit la scène en base sans attendre personne.
 */
export class Sessions {
    private readonly sessions = new Map<number, Session>();
    private readonly loading = new Map<number, Promise<Session>>();
    private readonly now: () => number;

    constructor(private readonly deps: SessionsDeps) {
        this.now = deps.now ?? Date.now;
    }

    participants(boardId: number): number {
        return this.sessions.get(boardId)?.peers.size ?? 0;
    }

    async join(input: JoinInput): Promise<{
        seq: number;
        elements: SceneElement[];
        peers: WhiteboardPeer[];
        overQuota: boolean;
    }> {
        let session = await this.open(input.boardId);
        if (session.home !== input.home) {
            // Déplacé entre la lecture de la ligne et l'ouverture : la séance repart de la base.
            await this.close(input.boardId, 'moved');
            session = await this.open(input.boardId);
        }
        if (!session.peers.has(input.clientId) && session.peers.size >= MAX_PEERS) {
            throw new FeatureError('conflict', 'Ce tableau a déjà trop de participants : réessayez plus tard.');
        }
        const at = this.now();
        session.peers.set(input.clientId, {
            clientId: input.clientId,
            connId: input.connId,
            userId: input.userId,
            workspaceId: input.workspaceId,
            name: input.name,
            color: input.color,
            canWrite: input.canWrite,
            seenAt: at
        });
        session.emptySince = null;
        if (at - session.quotaCheckedAt > QUOTA_RECHECK_MS) await this.checkQuota(session);
        this.publishPeers(session);
        return {
            seq: session.seq,
            elements: ordered(session.elements.values()),
            peers: this.peersOf(session),
            overQuota: session.overQuota
        };
    }

    async leave(boardId: number, clientId: string, userId: number): Promise<void> {
        const session = this.sessions.get(boardId);
        const peer = session?.peers.get(clientId);
        if (!session || !peer || peer.userId !== userId) return;
        session.peers.delete(clientId);
        this.publishPeers(session);
        if (session.peers.size === 0) {
            session.emptySince = this.now();
            await this.flush(session);
        }
    }

    push(boardId: number, clientId: string, userId: number, incoming: readonly SceneElement[]): PushResult {
        const session = this.sessions.get(boardId);
        const peer = session?.peers.get(clientId);
        if (!session || !peer || peer.userId !== userId) {
            throw new FeatureError('conflict', 'Séance expirée : le tableau se recharge.');
        }
        peer.seenAt = this.now();

        let delta = 0;
        let added = 0;
        const winners: { el: SceneElement; size: number }[] = [];
        for (const el of incoming) {
            const size = sizeOf(el);
            if (size > ELEMENT_MAX_CHARS) {
                throw new FeatureError('validation', 'Un élément du dessin est trop volumineux pour être enregistré.');
            }
            const current = session.elements.get(el.id);
            if (!wins(el, current)) continue;
            delta += size - (session.sizes.get(el.id) ?? 0);
            if (current === undefined) added++;
            winners.push({ el, size });
        }

        let refused: PushResult['refused'] = null;
        if (delta > 0 && session.overQuota) refused = 'quota';
        else if (session.bytes + delta > SCENE_MAX_BYTES || session.elements.size + added > SCENE_MAX_ELEMENTS) {
            refused = 'tooLarge';
        }
        // Une poussée qui agrandit est écartée en entier : la moitié d'un geste
        // (un trait sans son groupe) serait pire que rien.
        if (refused !== null || winners.length === 0) return { seq: session.seq, accepted: 0, refused };

        for (const { el, size } of winners) {
            session.elements.set(el.id, el);
            session.sizes.set(el.id, size);
        }
        session.bytes += delta;
        session.seq += 1;
        session.edits += 1;
        session.lastEditAt = this.now();
        session.dirtySince ??= session.lastEditAt;
        session.lastUserId = userId;
        this.broadcast(session, WHITEBOARD_ELEMENTS_EVENT, {
            boardId,
            seq: session.seq,
            from: clientId,
            elements: winners.map((w) => w.el)
        });
        return { seq: session.seq, accepted: winners.length, refused: null };
    }

    presence(boardId: number, clientId: string, userId: number, presence: WhiteboardPresence): void {
        const session = this.sessions.get(boardId);
        const peer = session?.peers.get(clientId);
        if (!session || !peer || peer.userId !== userId) {
            throw new FeatureError('conflict', 'Séance expirée : le tableau se recharge.');
        }
        peer.seenAt = this.now();
        if (session.peers.size < 2) return;
        this.broadcast(session, WHITEBOARD_PRESENCE_EVENT, { boardId, clientId, ...presence });
    }

    /** Une image vient d'arriver : les autres participants la demandent. */
    notifyFile(boardId: number, fileId: string): void {
        const session = this.sessions.get(boardId);
        if (session) this.broadcast(session, WHITEBOARD_FILE_EVENT, { boardId, fileId });
    }

    /** Le fond ou le thème a changé : tous les participants l'appliquent, l'auteur compris. */
    notifyAppearance(boardId: number, appearance: BoardAppearance): void {
        const session = this.sessions.get(boardId);
        if (session) this.broadcast(session, WHITEBOARD_APPEARANCE_EVENT, { boardId, ...appearance });
    }

    /** Avant une copie : la base porte tout ce que la séance tient. */
    async flushNow(boardId: number): Promise<void> {
        const session = this.sessions.get(boardId);
        if (!session) return;
        await session.saving;
        await this.flush(session);
        await session.saving;
    }

    /**
     * Ferme la séance, écrite d'abord sauf `discard` (une suppression), et
     * prévient les participants, dont l'écran se referme.
     */
    async close(boardId: number, reason: 'removed' | 'moved', opts: { discard?: boolean } = {}): Promise<void> {
        const session = this.sessions.get(boardId);
        if (!session) return;
        if (!opts.discard) await this.flushNow(boardId);
        this.sessions.delete(boardId);
        if (session.peers.size > 0) this.broadcast(session, WHITEBOARD_CLOSED_EVENT, { boardId, reason });
    }

    async tick(): Promise<void> {
        const at = this.now();
        for (const session of [...this.sessions.values()]) {
            let left = false;
            for (const [clientId, peer] of session.peers) {
                if (at - peer.seenAt > PEER_TTL_MS) {
                    session.peers.delete(clientId);
                    left = true;
                }
            }
            if (left) {
                this.publishPeers(session);
                if (session.peers.size === 0) session.emptySince = at;
            }
            if (session.peers.size > 0 && at - session.quotaCheckedAt > QUOTA_RECHECK_MS) {
                await this.checkQuota(session);
            }
            const due =
                session.dirtySince !== null &&
                session.saving === null &&
                session.tooLargeAtEdit !== session.edits &&
                (at - session.lastEditAt >= SAVE_IDLE_MS || at - session.dirtySince >= SAVE_MAX_DIRTY_MS);
            if (due) await this.flush(session);
            if (
                session.peers.size === 0 &&
                session.dirtySince === null &&
                session.saving === null &&
                session.emptySince !== null &&
                at - session.emptySince > EVICT_AFTER_MS
            ) {
                this.sessions.delete(session.boardId);
            }
        }
    }

    /** À l'arrêt du serveur : tout ce qui n'est pas écrit l'est. */
    async stop(): Promise<void> {
        for (const session of this.sessions.values()) {
            await session.saving;
            await this.flush(session);
            await session.saving;
        }
        this.sessions.clear();
    }

    // ── Interne ────────────────────────────────────────────────────────────

    private async open(boardId: number): Promise<Session> {
        const live = this.sessions.get(boardId);
        if (live) return live;
        const pending = this.loading.get(boardId);
        if (pending) return pending;
        if (this.sessions.size >= MAX_SESSIONS) {
            throw new FeatureError(
                'conflict',
                'Trop de tableaux sont ouverts sur ce serveur : réessayez dans un instant.'
            );
        }
        const load = (async () => {
            const stored = await this.deps.store.load(boardId);
            if (stored === null) throw new FeatureError('not_found', 'Ce tableau n’existe plus.');
            const session: Session = {
                boardId,
                home: stored.workspaceId,
                elements: new Map(),
                sizes: new Map(),
                bytes: 0,
                version: stored.version,
                seq: 0,
                edits: 0,
                dirtySince: null,
                lastEditAt: 0,
                lastUserId: null,
                tooLargeAtEdit: null,
                peers: new Map(),
                overQuota: false,
                quotaCheckedAt: 0,
                saving: null,
                emptySince: null,
                changedAt: 0
            };
            for (const el of stored.elements) {
                const size = sizeOf(el);
                session.elements.set(el.id, el);
                session.sizes.set(el.id, size);
                session.bytes += size;
            }
            this.sessions.set(boardId, session);
            return session;
        })();
        this.loading.set(boardId, load);
        try {
            return await load;
        } finally {
            this.loading.delete(boardId);
        }
    }

    private flush(session: Session): Promise<void> {
        if (session.saving) return session.saving;
        if (session.dirtySince === null) return Promise.resolve();
        session.bytes -= pruneTombstones(session.elements, session.sizes, this.now());
        const editsAtSnapshot = session.edits;
        const snapshot = ordered(session.elements.values());
        session.saving = this.deps.store
            .save({
                boardId: session.boardId,
                workspaceId: session.home,
                baseVersion: session.version,
                elements: snapshot,
                userId: session.lastUserId
            })
            .then(async (result) => {
                if (result.ok) {
                    session.version = result.version;
                    session.tooLargeAtEdit = null;
                    if (session.edits === editsAtSnapshot) session.dirtySince = null;
                    this.broadcast(session, WHITEBOARD_SAVED_EVENT, {
                        boardId: session.boardId,
                        at: Math.floor(this.now() / 1000),
                        failure: null
                    });
                    if (this.now() - session.changedAt >= CHANGED_FLOOR_MS || session.peers.size === 0) {
                        session.changedAt = this.now();
                        this.deps.changed(session.home);
                    }
                    return;
                }
                if (result.reason === 'stale') {
                    await this.absorbStored(session);
                    return;
                }
                if (result.reason === 'tooLarge') {
                    session.tooLargeAtEdit = editsAtSnapshot;
                    this.broadcast(session, WHITEBOARD_SAVED_EVENT, {
                        boardId: session.boardId,
                        at: Math.floor(this.now() / 1000),
                        failure: 'tooLarge'
                    });
                    return;
                }
                this.sessions.delete(session.boardId);
                if (session.peers.size > 0) {
                    this.broadcast(session, WHITEBOARD_CLOSED_EVENT, {
                        boardId: session.boardId,
                        reason: result.reason === 'moved' ? 'moved' : 'removed'
                    });
                }
            })
            .catch((error: unknown) => {
                this.deps.logger.error({ err: error, boardId: session.boardId }, 'whiteboard: scène non écrite');
                this.broadcast(session, WHITEBOARD_SAVED_EVENT, {
                    boardId: session.boardId,
                    at: Math.floor(this.now() / 1000),
                    failure: 'error'
                });
            })
            .finally(() => {
                session.saving = null;
            });
        return session.saving;
    }

    /**
     * Quelqu'un a écrit la scène hors de cette séance (un autre serveur sur la
     * même base) : sa version se fusionne à la nôtre, et ce qu'elle apporte part
     * aux participants comme une poussée. L'écriture suivante repart de là.
     */
    private async absorbStored(session: Session): Promise<void> {
        const stored = await this.deps.store.load(session.boardId);
        if (stored === null || stored.workspaceId !== session.home) return;
        session.version = stored.version;
        const winners: SceneElement[] = [];
        for (const el of stored.elements) {
            if (!wins(el, session.elements.get(el.id))) continue;
            const size = sizeOf(el);
            session.bytes += size - (session.sizes.get(el.id) ?? 0);
            session.elements.set(el.id, el);
            session.sizes.set(el.id, size);
            winners.push(el);
        }
        if (winners.length === 0) return;
        session.seq += 1;
        this.broadcast(session, WHITEBOARD_ELEMENTS_EVENT, {
            boardId: session.boardId,
            seq: session.seq,
            from: SERVER_ORIGIN,
            elements: winners
        });
    }

    private async checkQuota(session: Session): Promise<void> {
        session.quotaCheckedAt = this.now();
        try {
            session.overQuota = await this.deps.store.ownerOverQuota(session.home);
        } catch (error) {
            // Une panne de la facturation ne bloque jamais un dessin.
            this.deps.logger.error({ err: error, boardId: session.boardId }, 'whiteboard: offre illisible');
            session.overQuota = false;
        }
    }

    private peersOf(session: Session): WhiteboardPeer[] {
        return [...session.peers.values()].map(({ clientId, connId, userId, name, color, canWrite }) => ({
            clientId,
            connId,
            userId,
            name,
            color,
            canWrite
        }));
    }

    private publishPeers(session: Session): void {
        this.broadcast(session, WHITEBOARD_PEERS_EVENT, { boardId: session.boardId, peers: this.peersOf(session) });
    }

    /** Une trame par salle des participants, à leurs seuls comptes. */
    private broadcast(session: Session, event: string, payload: unknown): void {
        const rooms = new Map<number, Set<number>>();
        for (const peer of session.peers.values()) {
            const users = rooms.get(peer.workspaceId) ?? new Set<number>();
            users.add(peer.userId);
            rooms.set(peer.workspaceId, users);
        }
        for (const [workspaceId, users] of rooms) this.deps.publishTo(workspaceId, [...users], event, payload);
    }
}
