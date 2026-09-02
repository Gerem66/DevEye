import type { WebSocket } from '@fastify/websocket';
import { randomUUID } from 'crypto';
import {
    LIVE_CHANGED_EVENT,
    LIVE_CURSORS_EVENT,
    LIVE_PEERS_EVENT,
    LIVE_TYPERS_EVENT,
    livePathGate,
    ok,
    topicFeatureOf,
    type FeatureAccess,
    type FeatureId,
    type LiveCursor,
    type LivePath,
    type LivePeer,
    type LiveTopic,
    type ServerMessage,
    type UserColor
} from '@deveye/types';

import { accessEpochNow, permissionsFor } from '@/features/_access';
import { isShareWired } from '@/features/_sharing';
import { logger } from '@/logger';
import type { Database } from '@/db';

/**
 * Le moteur de présence en direct : le roster (les pairs d'un espace et leur
 * lieu), les curseurs (entre pairs au même lieu) et les changements (« quelque
 * chose a bougé, re-sollicitez »). État local au processus, comme
 * {@link MonitorHub} ; l'interface reste étroite pour qu'un pub/sub partagé
 * puisse le remplacer.
 */

/** Période du balayage de vivacité. Deux tours sans `pong` ferment la socket. */
const HEARTBEAT_MS = 30_000;

/** Regroupement des diffusions : une seule vidange pour toutes les salles. */
const FLUSH_MS = 50;

/**
 * Plancher entre deux `live.changed` de même (espace, sujet). Doit rester
 * strictement inférieur à l'anti-rebond du client (250 ms,
 * `stores/invalidation.ts`), sinon une écriture étouffée ici ne serait jamais vue.
 */
const TOPIC_FLOOR_MS = 200;

/** Débit maximal accepté d'un client sur la voie rapide des curseurs. */
const CURSOR_FLOOR_MS = 25;

/** Trames de curseur hors cadence tolérées avant de fermer la socket. */
const CURSOR_STRIKES_MAX = 200;

/**
 * Durée de vie d'un « en train d'écrire » sans rafraîchissement : un onglet
 * fermé brutalement ne laisse pas un fantôme à l'écran.
 */
const TYPING_TTL_MS = 6_000;

/** Cadence du balayage de péremption, actif seulement pendant qu'on écrit. */
const TYPING_SWEEP_MS = 1_000;

/** Débit maximal accepté sur la voie rapide de la frappe. */
const TYPING_FLOOR_MS = 250;

/** Au-delà, la socket est en retard : on laisse tomber la trame de curseur. */
const BACKPRESSURE_BYTES = 64 * 1024;

interface Grants {
    features: ReadonlyMap<FeatureId, FeatureAccess>;
    /** Époque d'accès sous laquelle ces droits ont été résolus. */
    epoch: number;
}

export interface LiveConn {
    /** Identité de la socket : deux onglets sont deux connexions, un seul `sessionId`. */
    readonly connId: string;
    readonly socket: WebSocket;
    readonly userId: number;
    readonly sessionId: string;
    readonly joinedAt: number;

    /** Salle courante ; `null` tant qu'aucun `live.here` n'a abouti. */
    workspaceId: number | null;
    path: LivePath;
    color: UserColor | null;

    /**
     * Échéance du « en train d'écrire », en ms épochales ; `0` = n'écrit pas. Une
     * échéance plutôt qu'un booléen : pas de minuteur par connexion à annuler.
     */
    typingUntil: number;
    typingAt: number;
    /** A reçu des typers au dernier envoi : sert à lui livrer la liste vide. */
    hasTypingPeers: boolean;

    cursor: LiveCursor | null;
    cursorAt: number;
    cursorStrikes: number;
    /** A reçu des curseurs au dernier envoi : sert à lui livrer la liste vide. */
    hasCursorPeers: boolean;

    /**
     * Droits résolus par le dispatcheur, par espace : une même connexion en
     * détient pour sa salle et pour son espace personnel (`scope: 'account'`).
     */
    grants: Map<number, Grants>;

    /** Remis à `true` par l'événement `pong`. */
    alive: boolean;
}

/**
 * Ce qu'un handler voit du moteur, calqué sur `MonitorTransport`. Deux groupes,
 * volontairement distingués parce qu'ils n'ont pas la même portée.
 */
export interface LiveTransport {
    // -- portée : cette connexion ------------------------------------------

    /** Déclare le lieu de cette connexion et rend l'instantané de la salle. */
    here(workspaceId: number, path: LivePath, color: UserColor): LivePeer[];
    /** Propage un changement de couleur à toutes les connexions de ce compte. */
    colorChanged(color: UserColor): void;
    /** Annonce (ou retire) « en train d'écrire » aux pairs du même lieu. */
    typing(typing: boolean): void;

    // -- portée : le moteur entier, après une mutation d'accès -------------
    // À appeler partout où `invalidateAccess()` l'est : celle-ci n'est relue
    // qu'à la commande suivante, qu'une connexion assise n'émet pas forcément.

    /** Un compte perd l'accès à un espace : il sort de sa salle. */
    evict(workspaceId: number, userId: number): void;
    /** Le compte est suspendu ou supprimé : il sort de toutes les salles. */
    evictEverywhere(userId: number): void;
    /** L'espace disparaît : tout le monde sort. */
    evictRoom(workspaceId: number): void;
    /**
     * Prévenir un compte, où que ses connexions soient assises : gagner ou
     * perdre un espace se décide pendant que l'intéressé est ailleurs. Réservé
     * aux sujets sans droit de feature (comme `workspace`).
     */
    userChanged(userId: number, workspaceId: number, topics: readonly LiveTopic[], byUserId: number | null): void;
    /** Un rôle a changé sans que personne ne perde l'espace : droits re-résolus sur place. */
    resync(db: Database, workspaceId: number): Promise<void>;
}

export class LiveHub {
    private readonly bySocket = new Map<WebSocket, LiveConn>();
    private readonly byWorkspace = new Map<number, Set<LiveConn>>();

    private readonly dirtyRoster = new Set<number>();
    private readonly dirtyCursors = new Set<number>();
    private readonly dirtyTyping = new Set<number>();
    private typingSweepTimer: ReturnType<typeof setInterval> | null = null;
    private flushTimer: ReturnType<typeof setTimeout> | null = null;

    /** `${workspaceId}:${topic}` -> dernier envoi, pour le plancher de débit. */
    private readonly topicSentAt = new Map<string, number>();

    /**
     * Les espaces reliés à un espace par des projections d'éléments, pour une
     * feature (posé par `app.ts`). Ici et non chez les appelants : chaque
     * `changed` sur un sujet branché au partage est rejoué dans les espaces
     * reliés sans qu'aucun appelant n'ait à connaître la règle.
     */
    private shareLinks: ((workspaceId: number, feature: string) => Promise<number[]>) | null = null;

    /** Branche le résolveur d'espaces reliés. Sans lui, aucune traversée. */
    setShareLinks(resolver: (workspaceId: number, feature: string) => Promise<number[]>): void {
        this.shareLinks = resolver;
    }

    private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

    // ---------------------------------------------------------------- cycle de vie

    /**
     * Inscrit une connexion `/ws`, avant tout `live.here` : le battement de cœur
     * doit couvrir toutes les sockets, pas seulement les vues instrumentées.
     */
    register(socket: WebSocket, userId: number, sessionId: string): LiveTransport {
        const conn: LiveConn = {
            connId: randomUUID(),
            socket,
            userId,
            sessionId,
            joinedAt: Date.now(),
            workspaceId: null,
            path: [],
            color: null,
            typingUntil: 0,
            typingAt: 0,
            hasTypingPeers: false,
            cursor: null,
            cursorAt: 0,
            cursorStrikes: 0,
            hasCursorPeers: false,
            grants: new Map(),
            alive: true
        };
        this.bySocket.set(socket, conn);
        socket.on('pong', () => {
            conn.alive = true;
        });
        return createLiveTransport(this, socket);
    }

    drop(socket: WebSocket): void {
        const conn = this.bySocket.get(socket);
        if (!conn) return;
        this.bySocket.delete(socket);
        this.leaveRoom(conn);
    }

    /**
     * Un seul balayage pour toutes les sockets, plutôt qu'un minuteur par
     * connexion. `unref` : ce battement ne doit jamais retenir le processus.
     */
    startHeartbeat(): void {
        if (this.heartbeatTimer) return;
        this.heartbeatTimer = setInterval(() => this.sweep(), HEARTBEAT_MS);
        this.heartbeatTimer.unref?.();
    }

    stop(): void {
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
        if (this.flushTimer) clearTimeout(this.flushTimer);
        this.flushTimer = null;
        if (this.typingSweepTimer) clearInterval(this.typingSweepTimer);
        this.typingSweepTimer = null;
    }

    private sweep(): void {
        for (const conn of this.bySocket.values()) {
            if (!conn.alive) {
                // Pas de `close()` : une pile TCP morte ne verra jamais la poignée
                // de fermeture.
                try {
                    conn.socket.terminate();
                } catch {
                    /* déjà partie */
                }
                this.drop(conn.socket);
                continue;
            }
            conn.alive = false;
            try {
                conn.socket.ping();
            } catch {
                this.drop(conn.socket);
            }
        }
    }

    // ---------------------------------------------------------------- salles

    /**
     * Entrée en salle. Déplacement, jamais ajout : une connexion n'est dans
     * qu'une salle à la fois, sinon un `live.here` resté en file pendant une
     * bascule d'espace laisserait un fantôme permanent dans l'ancienne.
     */
    here(socket: WebSocket, workspaceId: number, path: LivePath, color: UserColor): LivePeer[] {
        const conn = this.bySocket.get(socket);
        if (!conn) return [];

        const moved = conn.workspaceId !== workspaceId;
        // Comparé AVANT l'affectation : une position n'a de sens que dans la
        // surface où elle a été prise, donc changer de lieu l'invalide.
        const relocated = moved || conn.path.join(' ') !== path.join(' ');
        if (moved && conn.workspaceId !== null) this.leaveRoom(conn);

        conn.workspaceId = workspaceId;
        conn.path = path;
        conn.color = color;
        // Changer de lieu invalide la frappe autant que la position : on
        // n'écrit pas « ici » depuis « ailleurs ».
        if (relocated) {
            conn.cursor = null;
            conn.typingUntil = 0;
        }

        let room = this.byWorkspace.get(workspaceId);
        if (!room) this.byWorkspace.set(workspaceId, (room = new Set()));
        room.add(conn);

        this.markRoster(workspaceId);
        this.markCursors(workspaceId);
        return this.projectRoster(room, conn);
    }

    private leaveRoom(conn: LiveConn): void {
        const wsId = conn.workspaceId;
        if (wsId === null) return;
        const room = this.byWorkspace.get(wsId);
        room?.delete(conn);
        if (room && room.size === 0) this.byWorkspace.delete(wsId);
        conn.workspaceId = null;
        conn.cursor = null;
        conn.typingUntil = 0;
        this.markRoster(wsId);
        this.markCursors(wsId);
        this.markTyping(wsId);
    }

    /**
     * Sortie forcée d'un compte d'une salle, après retrait d'accès :
     * `invalidateAccess()` n'est relue qu'à la commande suivante, qu'une
     * connexion assise n'émet pas forcément.
     */
    evict(workspaceId: number, userId: number): void {
        const room = this.byWorkspace.get(workspaceId);
        if (!room) return;
        for (const conn of [...room]) {
            if (conn.userId !== userId) continue;
            conn.grants.delete(workspaceId);
            this.leaveRoom(conn);
            // Un roster vide plutôt que le silence : l'interface de l'exclu
            // cesse d'afficher des pairs auxquels il n'a plus accès.
            this.send(conn, LIVE_PEERS_EVENT, { workspaceId, peers: [] });
        }
    }

    /** Le compte est suspendu ou supprimé : il sort de partout. */
    evictEverywhere(userId: number): void {
        for (const conn of [...this.bySocket.values()]) {
            if (conn.userId !== userId || conn.workspaceId === null) continue;
            this.evict(conn.workspaceId, userId);
        }
    }

    /** L'espace a disparu : sa salle avec lui. */
    evictRoom(workspaceId: number): void {
        const room = this.byWorkspace.get(workspaceId);
        if (!room) return;
        for (const conn of [...room]) {
            conn.grants.delete(workspaceId);
            this.leaveRoom(conn);
            this.send(conn, LIVE_PEERS_EVENT, { workspaceId, peers: [] });
        }
    }

    /**
     * Prévenir un compte précis, toutes ses connexions, salle ou pas. Pas de
     * plancher de débit : l'événement est rare par nature.
     */
    userChanged(userId: number, workspaceId: number, topics: readonly LiveTopic[], byUserId: number | null): void {
        if (topics.length === 0) return;
        for (const conn of this.bySocket.values()) {
            if (conn.userId !== userId) continue;
            this.send(conn, LIVE_CHANGED_EVENT, { workspaceId, topics, by: byUserId });
        }
    }

    // ---------------------------------------------------------------- droits

    /**
     * Instantané des droits, posé par le dispatcheur à chaque commande. Retenus
     * ici plutôt que ré-résolus à la diffusion, qui doit rester synchrone
     * (`forWorkspace()` peut rejeter).
     */
    rememberGrants(
        socket: WebSocket,
        workspaceId: number,
        features: ReadonlyMap<FeatureId, FeatureAccess>,
        epoch: number
    ): void {
        const conn = this.bySocket.get(socket);
        if (!conn) return;
        conn.grants.set(workspaceId, { features, epoch });
    }

    /**
     * Re-résout les droits de toute une salle après un changement de rôle : sans
     * ça, ils resteraient périmés (donc fermés) jusqu'à la prochaine commande.
     */
    async resync(db: Database, workspaceId: number): Promise<void> {
        const room = this.byWorkspace.get(workspaceId);
        if (!room || room.size === 0) return;
        const row = await db.workspaces.findById(workspaceId);
        if (!row) return;
        const epoch = accessEpochNow();
        await Promise.all(
            [...room].map(async (conn) => {
                try {
                    const perms = await permissionsFor(db, conn.userId, row);
                    conn.grants.set(workspaceId, {
                        features: new Map(perms.features.map((g) => [g.feature, g.access])),
                        epoch
                    });
                } catch {
                    // Compte devenu illisible (suspendu, supprimé) : on le laisse
                    // sans droits plutôt que de conserver les anciens.
                    conn.grants.delete(workspaceId);
                }
            })
        );
        this.markRoster(workspaceId);
    }

    private canRead(conn: LiveConn, workspaceId: number, feature: FeatureId): boolean {
        const g = conn.grants.get(workspaceId);
        // Époque périmée = aucun droit. Fail-closed, comme partout ailleurs.
        if (!g || g.epoch !== accessEpochNow()) return false;
        // `write` implique `read` : la présence de l'entrée suffit.
        return g.features.has(feature);
    }

    // ---------------------------------------------------------------- changements

    /**
     * Quelque chose a changé dans un espace. Appelé par le dispatcheur après
     * toute commande déclarant `mutates`, et directement par les tâches de fond,
     * qui écrivent sans commande et n'ont pas de socket.
     */
    changed(workspaceId: number, topics: readonly LiveTopic[], byUserId: number | null, exclude?: WebSocket): void {
        this.changedHere(workspaceId, topics, byUserId, exclude);

        // Puis les espaces reliés par des projections, pour les sujets branchés
        // au partage. Asynchrone et sans attente : la diffusion locale ne dépend
        // jamais d'une requête de plus, et un échec ici ne fait que retarder.
        if (this.shareLinks === null) return;
        for (const topic of topics) {
            const feature = topicFeatureOf(topic);
            if (feature === null || !isShareWired(feature)) continue;
            void this.shareLinks(workspaceId, feature)
                .then((linked) => {
                    for (const other of linked) {
                        if (other !== workspaceId) this.changedHere(other, [topic], byUserId, exclude);
                    }
                })
                .catch(() => {
                    // La prochaine écriture repassera.
                });
        }
    }

    /** La diffusion dans un seul espace. */
    private changedHere(
        workspaceId: number,
        topics: readonly LiveTopic[],
        byUserId: number | null,
        exclude?: WebSocket
    ): void {
        const room = this.byWorkspace.get(workspaceId);
        if (!room || room.size === 0 || topics.length === 0) return;

        const now = Date.now();
        const allowed = topics.filter((topic) => {
            const key = `${workspaceId}:${topic}`;
            if (now - (this.topicSentAt.get(key) ?? 0) < TOPIC_FLOOR_MS) return false;
            this.topicSentAt.set(key, now);
            return true;
        });
        if (allowed.length === 0) return;

        for (const conn of room) {
            // L'auteur a déjà la réponse de sa propre commande.
            if (conn.socket === exclude) continue;
            const visible = allowed.filter((topic) => this.canSeeTopic(conn, workspaceId, topic));
            if (visible.length === 0) continue;
            this.send(conn, LIVE_CHANGED_EVENT, { workspaceId, topics: visible, by: byUserId });
        }
    }

    /**
     * Voie de poussée d'un module (capacité `live.publish`) : une trame de SA
     * feature, aux connexions de la salle qui la lisent. Le nom de l'événement
     * est à lui, la charge n'est pas relue, et rien n'attend de réponse.
     *
     * Sans plancher de débit, contrairement à `changed` : une trame porte le
     * changement lui-même, l'étouffer le perdrait au lieu de le retarder. Ce
     * qui borne le débit est la cadence de la commande qui l'émet.
     */
    publishFeature(workspaceId: number, feature: FeatureId, event: string, payload: unknown): void {
        const room = this.byWorkspace.get(workspaceId);
        if (!room) return;
        for (const conn of room) {
            if (this.canRead(conn, workspaceId, feature)) this.send(conn, event, payload);
        }
    }

    private canSeeTopic(conn: LiveConn, workspaceId: number, topic: LiveTopic): boolean {
        const feature = topicFeatureOf(topic);
        // `null` = aucun droit de feature à vérifier, l'appartenance suffit.
        return feature === null || this.canRead(conn, workspaceId, feature);
    }

    /**
     * Un compte vient de changer de couleur : toutes ses connexions la portent,
     * dans toutes leurs salles. Le roster est la seule voie vivante.
     */
    colorChanged(socket: WebSocket, color: UserColor): void {
        const origin = this.bySocket.get(socket);
        if (!origin) return;
        for (const conn of this.bySocket.values()) {
            if (conn.userId !== origin.userId) continue;
            conn.color = color;
            if (conn.workspaceId !== null) this.markRoster(conn.workspaceId);
        }
    }

    // ---------------------------------------------------------------- curseurs

    /**
     * Voie rapide : une position, sans réponse ni validation d'autorisation.
     * L'espace de l'enveloppe est ignoré (il n'est validé que par
     * `access.forWorkspace()`, court-circuité ici) : seul `conn.workspaceId`,
     * posé par un `live.here` passé par le dispatcheur, fait foi.
     */
    cursor(socket: WebSocket, cursor: LiveCursor | null): void {
        const conn = this.bySocket.get(socket);
        if (!conn || conn.workspaceId === null) return;

        const now = Date.now();
        if (now - conn.cursorAt < CURSOR_FLOOR_MS) {
            conn.cursorStrikes += 1;
            if (conn.cursorStrikes > CURSOR_STRIKES_MAX) {
                logger.warn({ userId: conn.userId }, 'Live: cadence de curseur abusive, fermeture');
                try {
                    conn.socket.close(1008, 'cursor flood');
                } catch {
                    /* déjà partie */
                }
                this.drop(socket);
            }
            return;
        }

        conn.cursorStrikes = 0;
        conn.cursorAt = now;
        conn.cursor = cursor;
        this.markCursors(conn.workspaceId);
    }

    /**
     * Voie rapide : « j'écris » / « j'ai fini », sans réponse. Mêmes précautions
     * que {@link cursor} : le lieu vient du dernier `live.here`, jamais de la trame.
     */
    typing(socket: WebSocket, typing: boolean): void {
        const conn = this.bySocket.get(socket);
        if (!conn || conn.workspaceId === null) return;

        const now = Date.now();
        // Étouffement simple plutôt que compteur de fautes : la frappe est une
        // trame rare, l'ignorer suffit à la borner.
        if (now - conn.typingAt < TYPING_FLOOR_MS) return;
        conn.typingAt = now;

        const until = typing ? now + TYPING_TTL_MS : 0;
        // Un rappel identique ne change rien pour les pairs : on repousse
        // l'échéance sans reprogrammer de diffusion.
        const wasTyping = conn.typingUntil > now;
        conn.typingUntil = until;
        if (wasTyping === typing) return;

        this.markTyping(conn.workspaceId);
    }

    // ---------------------------------------------------------------- diffusion

    private markTyping(workspaceId: number): void {
        this.dirtyTyping.add(workspaceId);
        this.scheduleFlush();
        this.ensureTypingSweep();
    }

    /**
     * Balayage de péremption, vivant seulement pendant qu'on écrit : un pair qui
     * s'arrête net resterait sinon annoncé jusqu'à la prochaine diffusion. Un
     * seul minuteur pour tout le moteur.
     */
    private ensureTypingSweep(): void {
        if (this.typingSweepTimer) return;
        this.typingSweepTimer = setInterval(() => {
            const now = Date.now();
            let alive = false;
            for (const [workspaceId, room] of this.byWorkspace) {
                let expired = false;
                for (const conn of room) {
                    if (conn.typingUntil === 0) continue;
                    if (conn.typingUntil > now) alive = true;
                    else {
                        conn.typingUntil = 0;
                        expired = true;
                    }
                }
                if (expired) this.markTyping(workspaceId);
            }
            if (!alive && this.typingSweepTimer) {
                clearInterval(this.typingSweepTimer);
                this.typingSweepTimer = null;
            }
        }, TYPING_SWEEP_MS);
        this.typingSweepTimer.unref?.();
    }

    private markRoster(workspaceId: number): void {
        this.dirtyRoster.add(workspaceId);
        this.scheduleFlush();
    }

    private markCursors(workspaceId: number): void {
        this.dirtyCursors.add(workspaceId);
        this.scheduleFlush();
    }

    private scheduleFlush(): void {
        if (this.flushTimer) return;
        this.flushTimer = setTimeout(() => {
            this.flushTimer = null;
            this.flush();
        }, FLUSH_MS);
        this.flushTimer.unref?.();
    }

    private flush(): void {
        const rosterRooms = [...this.dirtyRoster];
        const cursorRooms = [...this.dirtyCursors];
        const typingRooms = [...this.dirtyTyping];
        this.dirtyRoster.clear();
        this.dirtyCursors.clear();
        this.dirtyTyping.clear();
        for (const wsId of rosterRooms) this.flushRoster(wsId);
        for (const wsId of cursorRooms) this.flushCursors(wsId);
        for (const wsId of typingRooms) this.flushTyping(wsId);
    }

    /**
     * Le roster, **projeté par destinataire** : chacun reçoit les chemins qu'il
     * a le droit de voir, les autres réduits à « ailleurs ».
     */
    private flushRoster(workspaceId: number): void {
        const room = this.byWorkspace.get(workspaceId);
        if (!room || room.size === 0) return;
        for (const recipient of room) {
            this.send(recipient, LIVE_PEERS_EVENT, {
                workspaceId,
                peers: this.projectRoster(room, recipient)
            });
        }
    }

    /**
     * Coût : pairs × destinataires. Une salle compte une poignée de membres ;
     * pour des salles à plusieurs dizaines, mémoïser ici par signature de droits.
     */
    private projectRoster(room: Set<LiveConn>, recipient: LiveConn): LivePeer[] {
        const wsId = recipient.workspaceId;
        if (wsId === null) return [];
        const peers: LivePeer[] = [];
        for (const peer of room) {
            // `here` pose toujours la couleur : ce filtre évite juste d'inventer
            // une couleur de repli qui masquerait un défaut.
            if (peer.color === null) continue;
            peers.push({
                connId: peer.connId,
                userId: peer.userId,
                color: peer.color,
                workspaceId: wsId,
                // Son propre chemin n'est jamais tronqué.
                path: peer === recipient ? peer.path : this.visiblePath(recipient, wsId, peer.path),
                cursor: peer.cursor
            });
        }
        return peers;
    }

    /**
     * Le chemin d'un pair tel que ce destinataire a le droit de le voir. Seule
     * la racine est examinée : un segment plus profond appartient à la même
     * feature. Les vues de compte et d'administration sont `private` et ne sont
     * montrées à personne, pas même à un administrateur.
     */
    private visiblePath(recipient: LiveConn, workspaceId: number, path: LivePath): LivePath {
        if (path.length === 0) return [];
        const gate = livePathGate(path[0]);
        if (gate === 'private') return [];
        if (gate === 'public') return path;
        return this.canRead(recipient, workspaceId, gate) ? path : [];
    }

    /** Les curseurs ne circulent qu'entre pairs situés au **même chemin exactement**. */
    private flushCursors(workspaceId: number): void {
        const room = this.byWorkspace.get(workspaceId);
        if (!room || room.size === 0) return;

        const byPath = new Map<string, LiveConn[]>();
        for (const conn of room) {
            const key = conn.path.join(' ');
            const group = byPath.get(key);
            if (group) group.push(conn);
            else byPath.set(key, [conn]);
        }

        for (const group of byPath.values()) {
            for (const recipient of group) {
                const cursors = group
                    .filter((peer) => peer !== recipient && peer.cursor !== null)
                    .map((peer) => ({ connId: peer.connId, userId: peer.userId, cursor: peer.cursor! }));
                // Une liste vide n'est envoyée qu'à qui en avait une : le dernier
                // curseur d'un pair parti doit s'effacer, sans bruit pour les autres.
                if (cursors.length === 0 && !recipient.hasCursorPeers) continue;
                recipient.hasCursorPeers = cursors.length > 0;
                this.send(recipient, LIVE_CURSORS_EVENT, { workspaceId, cursors });
            }
        }
    }

    /**
     * Qui écrit, entre pairs situés au **même chemin exactement** — même
     * projection que les curseurs, donc la frappe sur une carte n'est annoncée
     * qu'à ceux qui regardent cette carte.
     */
    private flushTyping(workspaceId: number): void {
        const room = this.byWorkspace.get(workspaceId);
        if (!room || room.size === 0) return;

        const now = Date.now();
        const byPath = new Map<string, LiveConn[]>();
        for (const conn of room) {
            const key = conn.path.join(' ');
            const group = byPath.get(key);
            if (group) group.push(conn);
            else byPath.set(key, [conn]);
        }

        for (const group of byPath.values()) {
            for (const recipient of group) {
                const typers = group
                    .filter((peer) => peer !== recipient && peer.typingUntil > now)
                    .map((peer) => ({ connId: peer.connId, userId: peer.userId }));
                // Même règle que les curseurs : une liste vide seulement à qui en
                // avait une.
                if (typers.length === 0 && !recipient.hasTypingPeers) continue;
                recipient.hasTypingPeers = typers.length > 0;
                this.send(recipient, LIVE_TYPERS_EVENT, { workspaceId, typers });
            }
        }
    }

    /**
     * Un envoi ne doit jamais lever : le dispatcheur diffuse depuis le `try`
     * d'une commande déjà répondue.
     */
    private send(conn: LiveConn, command: string, data: unknown): void {
        try {
            if (conn.socket.bufferedAmount > BACKPRESSURE_BYTES) return;
            const msg: ServerMessage = { command, payload: ok(data) };
            conn.socket.send(JSON.stringify(msg));
        } catch {
            /* socket en fermeture : le `close` fera le ménage */
        }
    }
}

export function createLiveTransport(hub: LiveHub, socket: WebSocket): LiveTransport {
    return {
        here: (workspaceId, path, color) => hub.here(socket, workspaceId, path, color),
        colorChanged: (color) => hub.colorChanged(socket, color),
        typing: (typing) => hub.typing(socket, typing),
        evict: (workspaceId, userId) => hub.evict(workspaceId, userId),
        evictEverywhere: (userId) => hub.evictEverywhere(userId),
        evictRoom: (workspaceId) => hub.evictRoom(workspaceId),
        userChanged: (userId, workspaceId, topics, byUserId) => hub.userChanged(userId, workspaceId, topics, byUserId),
        resync: (db, workspaceId) => hub.resync(db, workspaceId)
    };
}
