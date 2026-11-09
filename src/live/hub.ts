import type { WebSocket } from '@fastify/websocket';
import { randomUUID } from 'crypto';
import {
    LIVE_CHANGED_EVENT,
    LIVE_CURSORS_EVENT,
    LIVE_PEERS_EVENT,
    LIVE_SAYS_EVENT,
    LIVE_TYPERS_EVENT,
    livePathGate,
    ok,
    topicFeatureOf,
    type FeatureAccess,
    type FeatureId,
    type LiveCursor,
    type LiveCursorFrame,
    type LivePath,
    type LivePeer,
    type LiveTopic,
    type Seat,
    type ServerMessage,
    type UserColor
} from '@deveye/types';

import { accessEpochNow, permissionsFor } from '@/features/_access';
import { isModuleShareWired } from '@/features/_sdk/register';
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

/**
 * Débit maximal accepté sur la voie rapide de la bulle. Doit rester
 * strictement inférieur à la cadence d'émission du client (150 ms,
 * `client/src/live/cursorChat.ts`) : une trame de texte porte un état, et
 * l'étouffer ici la perd au lieu de la retarder, laissant la bulle des pairs
 * figée sur une frappe périmée jusqu'à la suivante.
 */
const SAY_FLOOR_MS = 100;

/** Au-delà, la socket est en retard : on laisse tomber la trame de curseur. */
const BACKPRESSURE_BYTES = 64 * 1024;

/**
 * Le laissez-passer d'une connexion pour un canal de curseurs, donné par le
 * module qui a vérifié qu'elle voit l'élément (`ctx.live.joinCursors`).
 */
export interface CursorPass {
    channel: string;
    feature: FeatureId;
    /** L'espace de la commande qui l'a donné : celui qu'affiche son client. */
    workspaceId: number;
    /** Son pseudo, pour les pairs d'un autre espace qui ne le connaissent pas. */
    name: string;
}

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
    /** La place qu'il occupe (`Services/admission.ts`) ; `null` : exempté, non compté. */
    readonly seat: Seat | null;
    /** Le dernier geste de la personne dans cet onglet (`session.active`), en ms épochales. */
    activeAt: number;

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
    /** La surface de ce curseur : le canal que nomme sa dernière trame, `null` pour la popup. */
    cursorChannel: string | null;
    cursorPass: CursorPass | null;
    cursorAt: number;
    cursorStrikes: number;
    /** A reçu des curseurs au dernier envoi : sert à lui livrer la liste vide. */
    hasCursorPeers: boolean;

    /** Le texte affiché au curseur ; `null` = pas de bulle. */
    say: string | null;
    sayAt: number;
    /** A reçu des bulles au dernier envoi : sert à lui livrer la liste vide. */
    hasSayPeers: boolean;

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
    /** Ouvre un canal de curseurs à cette connexion ; rend son identifiant, `null` si elle est partie. */
    grantCursors(pass: CursorPass, color: UserColor): string | null;
    /** Lui retire ce canal, si elle y a son laissez-passer. */
    revokeCursors(channel: string): void;

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
     * Ferme les sockets d'un compte, sauf celles de la session gardée : ce qui
     * était ouvert sous un secret révoqué (mot de passe changé, suspension) ne
     * continue pas sur une socket authentifiée une fois pour toutes.
     */
    closeSessionsOf(userId: number, keepSessionId?: string): void;
    /** Ferme les sockets d'une seule session (déconnexion, jeton réutilisé). */
    closeSession(sessionId: string): void;
    /**
     * Prévenir un compte, où que ses connexions soient assises : gagner ou
     * perdre un espace se décide pendant que l'intéressé est ailleurs. Réservé
     * aux sujets sans droit de feature (comme `workspace`).
     */
    userChanged(userId: number, workspaceId: number, topics: readonly LiveTopic[], byUserId: number | null): void;
    /**
     * Prévenir la salle d'un espace autre que celui de l'enveloppe, le seul que
     * `mutates` sache battre : accepter une invitation écrit dans un espace où
     * l'appelant n'est pas encore assis.
     */
    changed(workspaceId: number, topics: readonly LiveTopic[], byUserId: number): void;
    /** Un rôle a changé sans que personne ne perde l'espace : droits re-résolus sur place. */
    resync(db: Database, workspaceId: number): Promise<void>;
}

export class LiveHub {
    private readonly bySocket = new Map<WebSocket, LiveConn>();
    private readonly byWorkspace = new Map<number, Set<LiveConn>>();
    /** Les connexions dont le curseur est dans un canal, par canal. */
    private readonly byChannel = new Map<string, Set<LiveConn>>();

    private readonly dirtyRoster = new Set<number>();
    private readonly dirtyCursors = new Set<number>();
    private readonly dirtyTyping = new Set<number>();
    private readonly dirtySays = new Set<number>();
    private readonly dirtyChannelCursors = new Set<string>();
    private readonly dirtyChannelSays = new Set<string>();
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
    /** Les sockets de navigateur ouvertes : ce que les Mesures relèvent avec leurs chiffres. */
    socketCount(): number {
        return this.bySocket.size;
    }

    register(socket: WebSocket, userId: number, sessionId: string, seat: Seat | null = null): LiveTransport {
        const now = Date.now();
        const conn: LiveConn = {
            connId: randomUUID(),
            socket,
            userId,
            sessionId,
            joinedAt: now,
            seat,
            activeAt: now,
            workspaceId: null,
            path: [],
            color: null,
            typingUntil: 0,
            typingAt: 0,
            hasTypingPeers: false,
            cursor: null,
            cursorChannel: null,
            cursorPass: null,
            cursorAt: 0,
            cursorStrikes: 0,
            hasCursorPeers: false,
            say: null,
            sayAt: 0,
            hasSayPeers: false,
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
        this.revokePass(conn);
        this.leaveRoom(conn);
        if (!this.holdsSocket(conn.userId)) this.lastSocketGone?.(conn.userId, conn.seat);
    }

    private lastSocketGone: ((userId: number, seat: Seat | null) => void) | null = null;

    /** La dernière socket d'un compte vient de partir : l'admission lui garde sa place un moment. */
    onLastSocketGone(fn: (userId: number, seat: Seat | null) => void): void {
        this.lastSocketGone = fn;
    }

    noteActive(socket: WebSocket): void {
        const conn = this.bySocket.get(socket);
        if (conn) conn.activeAt = Date.now();
    }

    holdsSocket(userId: number): boolean {
        for (const conn of this.bySocket.values()) if (conn.userId === userId) return true;
        return false;
    }

    /** Les comptes assis dans cette catégorie, et le plus récent geste de leurs onglets. */
    seated(seat: Seat): Map<number, number> {
        const out = new Map<number, number>();
        for (const conn of this.bySocket.values()) {
            if (conn.seat === seat) out.set(conn.userId, Math.max(out.get(conn.userId) ?? 0, conn.activeAt));
        }
        return out;
    }

    closeUser(userId: number, code: number, reason: string): void {
        for (const conn of [...this.bySocket.values()]) {
            if (conn.userId === userId) conn.socket.close(code, reason);
        }
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
        // n'écrit pas « ici » depuis « ailleurs ». La surface d'un canal, elle,
        // ne doit rien au chemin.
        if (relocated) {
            if (conn.cursorChannel === null) {
                conn.cursor = null;
                conn.say = null;
            }
            conn.typingUntil = 0;
        }

        let room = this.byWorkspace.get(workspaceId);
        if (!room) this.byWorkspace.set(workspaceId, (room = new Set()));
        room.add(conn);

        this.markRoster(workspaceId);
        this.markCursors(workspaceId);
        // Sans quoi un arrivant ne verrait les bulles et les frappes déjà en
        // cours qu'au prochain changement d'état de leurs auteurs, que le rappel
        // périodique de la frappe n'émet même pas.
        this.markSays(workspaceId);
        this.markTyping(workspaceId);
        return this.projectRoster(room, conn);
    }

    private leaveRoom(conn: LiveConn): void {
        const wsId = conn.workspaceId;
        if (wsId === null) return;
        // Quitter l'espace qui a donné le laissez-passer, c'est quitter l'élément qu'il ouvrait.
        if (conn.cursorPass?.workspaceId === wsId) this.revokePass(conn);
        const room = this.byWorkspace.get(wsId);
        room?.delete(conn);
        if (room && room.size === 0) this.byWorkspace.delete(wsId);
        conn.workspaceId = null;
        conn.cursor = null;
        conn.typingUntil = 0;
        conn.say = null;
        this.markRoster(wsId);
        this.markCursors(wsId);
        this.markTyping(wsId);
        this.markSays(wsId);
    }

    /**
     * Sortie forcée d'un compte d'une salle, après retrait d'accès :
     * `invalidateAccess()` n'est relue qu'à la commande suivante, qu'une
     * connexion assise n'émet pas forcément.
     */
    evict(workspaceId: number, userId: number): void {
        this.revokePassWhere((conn) => conn.userId === userId && conn.cursorPass?.workspaceId === workspaceId);
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
        this.revokePassWhere((conn) => conn.userId === userId);
        for (const conn of [...this.bySocket.values()]) {
            if (conn.userId !== userId || conn.workspaceId === null) continue;
            this.evict(conn.workspaceId, userId);
        }
    }

    closeSessionsOf(userId: number, keepSessionId?: string): void {
        for (const conn of [...this.bySocket.values()]) {
            if (conn.userId !== userId || conn.sessionId === keepSessionId) continue;
            conn.socket.close(4401, 'session revoked');
        }
    }

    /** Toutes les connexions d'une session de connexion, quels que soient leur onglet et leur salle. */
    toSession(sessionId: string, command: string, data: unknown): void {
        for (const conn of this.bySocket.values()) {
            if (conn.sessionId === sessionId) this.send(conn, command, data);
        }
    }

    closeSession(sessionId: string): void {
        for (const conn of [...this.bySocket.values()]) {
            if (conn.sessionId === sessionId) conn.socket.close(4401, 'session revoked');
        }
    }

    /** L'espace a disparu : sa salle avec lui. */
    evictRoom(workspaceId: number): void {
        this.revokePassWhere((conn) => conn.cursorPass?.workspaceId === workspaceId);
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

    /** Toutes les connexions de ce serveur, salle ou pas, fédérées comprises. */
    broadcast(command: string, data: unknown): void {
        for (const conn of this.bySocket.values()) this.send(conn, command, data);
    }

    /** Ferme les connexions des comptes que `refuse` désigne. */
    closeWhere(refuse: (userId: number) => boolean, code: number, reason: string): void {
        for (const conn of [...this.bySocket.values()]) {
            if (refuse(conn.userId)) conn.socket.close(code, reason);
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
                const pass = conn.cursorPass?.workspaceId === workspaceId ? conn.cursorPass : null;
                try {
                    const perms = await permissionsFor(db, conn.userId, row);
                    conn.grants.set(workspaceId, {
                        features: new Map(perms.features.map((g) => [g.feature, g.access])),
                        epoch
                    });
                    if (pass && !perms.features.some((g) => g.feature === pass.feature)) this.revokePass(conn);
                } catch {
                    // Compte devenu illisible (suspendu, supprimé) : on le laisse
                    // sans droits plutôt que de conserver les anciens.
                    conn.grants.delete(workspaceId);
                    if (pass) this.revokePass(conn);
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
            if (feature === null || !isModuleShareWired(feature)) continue;
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
     *
     * `userIds` restreint la trame aux connexions de ces comptes : les
     * participants d'un élément que le rôle d'un autre membre lui masque.
     */
    publishFeature(
        workspaceId: number,
        feature: FeatureId,
        event: string,
        payload: unknown,
        userIds?: readonly number[]
    ): void {
        const room = this.byWorkspace.get(workspaceId);
        if (!room) return;
        for (const conn of room) {
            if (userIds && !userIds.includes(conn.userId)) continue;
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
     * posé par un `live.here` passé par le dispatcheur, fait foi. Un canal ne
     * s'emprunte qu'avec le laissez-passer qu'un module a donné à la connexion.
     */
    cursor(socket: WebSocket, frame: LiveCursorFrame): void {
        const conn = this.bySocket.get(socket);
        if (!conn) return;
        if (frame.channel === null ? conn.workspaceId === null : conn.cursorPass?.channel !== frame.channel) return;

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
        if (frame.channel !== conn.cursorChannel) this.moveCursor(conn, frame.channel);
        conn.cursor = frame.cursor;
        this.markCursorsOf(conn);
    }

    /** Donné par le module, qui a vérifié qu'elle voit l'élément ; son curseur n'y entre qu'en le nommant. */
    grantCursors(socket: WebSocket, pass: CursorPass, color: UserColor): string | null {
        const conn = this.bySocket.get(socket);
        if (!conn) return null;
        if (conn.cursorPass?.channel !== pass.channel) this.revokePass(conn);
        conn.cursorPass = pass;
        // Donné avant son premier `live.here` : sa couleur voyage quand même.
        conn.color ??= color;
        return conn.connId;
    }

    revokeCursors(socket: WebSocket, channel: string): void {
        const conn = this.bySocket.get(socket);
        if (conn?.cursorPass?.channel === channel) this.revokePass(conn);
    }

    private revokePass(conn: LiveConn): void {
        if (conn.cursorPass === null) return;
        if (conn.cursorChannel === conn.cursorPass.channel) this.moveCursor(conn, null);
        conn.cursorPass = null;
    }

    private revokePassWhere(match: (conn: LiveConn) => boolean): void {
        for (const conn of this.bySocket.values()) if (match(conn)) this.revokePass(conn);
    }

    /**
     * Le curseur change de surface : il quitte les pairs de l'ancienne, effacé
     * avec sa bulle, puisqu'une position ne vaut que dans la surface où elle a
     * été prise.
     */
    private moveCursor(conn: LiveConn, channel: string | null): void {
        this.markCursorsOf(conn);
        this.markSaysOf(conn);
        if (conn.cursorChannel !== null) {
            const members = this.byChannel.get(conn.cursorChannel);
            members?.delete(conn);
            if (members?.size === 0) this.byChannel.delete(conn.cursorChannel);
        }
        conn.cursorChannel = channel;
        conn.cursor = null;
        conn.say = null;
        if (channel !== null) {
            let members = this.byChannel.get(channel);
            if (!members) this.byChannel.set(channel, (members = new Set()));
            members.add(conn);
        }
        this.markCursorsOf(conn);
        this.markSaysOf(conn);
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

    /**
     * Voie rapide : le texte affiché au curseur. Mêmes précautions que
     * {@link cursor}. Pas de péremption : la bulle n'est dessinée que là où un
     * curseur l'est, elle hérite donc de sa durée de vie.
     */
    say(socket: WebSocket, message: string | null): void {
        const conn = this.bySocket.get(socket);
        if (!conn || (conn.workspaceId === null && conn.cursorChannel === null)) return;

        const now = Date.now();
        // Étouffement simple, comme la frappe : la cadence est celle d'un humain
        // qui tape, et le client tient déjà son propre plancher. Le retrait, lui,
        // passe toujours : une fermeture qui suit de près une frappe laisserait
        // sinon la bulle affichée chez les pairs pour de bon.
        if (message !== null && now - conn.sayAt < SAY_FLOOR_MS) return;
        conn.sayAt = now;

        if (conn.say === message) return;
        conn.say = message;
        this.markSaysOf(conn);
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

    private markSays(workspaceId: number): void {
        this.dirtySays.add(workspaceId);
        this.scheduleFlush();
    }

    /** Les pairs de la surface de ce curseur : son canal, sinon sa salle. */
    private markCursorsOf(conn: LiveConn): void {
        if (conn.cursorChannel !== null) {
            this.dirtyChannelCursors.add(conn.cursorChannel);
            this.scheduleFlush();
        } else if (conn.workspaceId !== null) this.markCursors(conn.workspaceId);
    }

    private markSaysOf(conn: LiveConn): void {
        if (conn.cursorChannel !== null) {
            this.dirtyChannelSays.add(conn.cursorChannel);
            this.scheduleFlush();
        } else if (conn.workspaceId !== null) this.markSays(conn.workspaceId);
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
        const sayRooms = [...this.dirtySays];
        const cursorChannels = [...this.dirtyChannelCursors];
        const sayChannels = [...this.dirtyChannelSays];
        this.dirtyRoster.clear();
        this.dirtyCursors.clear();
        this.dirtyTyping.clear();
        this.dirtySays.clear();
        this.dirtyChannelCursors.clear();
        this.dirtyChannelSays.clear();
        for (const wsId of rosterRooms) this.flushRoster(wsId);
        for (const wsId of cursorRooms) this.sendCursors(this.pathGroups(wsId), null);
        for (const channel of cursorChannels) this.sendCursors(this.channelGroup(channel), channel);
        for (const wsId of typingRooms) this.flushTyping(wsId);
        for (const wsId of sayRooms) this.sendSays(this.pathGroups(wsId));
        for (const channel of sayChannels) this.sendSays(this.channelGroup(channel));
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
                // La position dans un canal ne regarde que ce canal, pas toute la salle.
                cursor: peer.cursorChannel === null ? peer.cursor : null
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

    /**
     * Ceux d'une salle qui partagent une surface : les pairs situés au **même
     * chemin exactement**, hors de ceux dont le curseur est dans un canal.
     */
    private pathGroups(workspaceId: number): LiveConn[][] {
        const room = this.byWorkspace.get(workspaceId);
        if (!room) return [];
        const byPath = new Map<string, LiveConn[]>();
        for (const conn of room) {
            if (conn.cursorChannel !== null) continue;
            const key = conn.path.join('\0');
            const group = byPath.get(key);
            if (group) group.push(conn);
            else byPath.set(key, [conn]);
        }
        return [...byPath.values()];
    }

    /** Ceux d'un canal, d'où que vienne leur connexion. */
    private channelGroup(channel: string): LiveConn[][] {
        const members = this.byChannel.get(channel);
        return members ? [[...members]] : [];
    }

    /** L'espace qu'affiche le client de cette connexion : celui de son laissez-passer quand son curseur est dans un canal. */
    private shownWorkspace(conn: LiveConn): number | null {
        return conn.cursorChannel !== null ? (conn.cursorPass?.workspaceId ?? null) : conn.workspaceId;
    }

    /** Les curseurs ne circulent qu'entre pairs d'une même surface. */
    private sendCursors(groups: LiveConn[][], channel: string | null): void {
        for (const group of groups) {
            for (const recipient of group) {
                const workspaceId = this.shownWorkspace(recipient);
                if (workspaceId === null) continue;
                const cursors = group.flatMap((peer) =>
                    peer === recipient || peer.cursor === null || peer.color === null
                        ? []
                        : [
                              {
                                  connId: peer.connId,
                                  userId: peer.userId,
                                  color: peer.color,
                                  name: channel === null ? null : (peer.cursorPass?.name ?? null),
                                  cursor: peer.cursor
                              }
                          ]
                );
                // Une liste vide n'est envoyée qu'à qui en avait une : le dernier
                // curseur d'un pair parti doit s'effacer, sans bruit pour les autres.
                if (cursors.length === 0 && !recipient.hasCursorPeers) continue;
                recipient.hasCursorPeers = cursors.length > 0;
                this.send(recipient, LIVE_CURSORS_EVENT, { workspaceId, channel, cursors });
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

    /** Les bulles, entre pairs d'une même surface : celle des curseurs, sous lesquels elles se dessinent. */
    private sendSays(groups: LiveConn[][]): void {
        for (const group of groups) {
            for (const recipient of group) {
                const workspaceId = this.shownWorkspace(recipient);
                if (workspaceId === null) continue;
                const says = group
                    .filter((peer) => peer !== recipient && peer.say !== null)
                    .map((peer) => ({ connId: peer.connId, userId: peer.userId, text: peer.say! }));
                // Même règle que les curseurs : une liste vide seulement à qui en
                // avait une.
                if (says.length === 0 && !recipient.hasSayPeers) continue;
                recipient.hasSayPeers = says.length > 0;
                this.send(recipient, LIVE_SAYS_EVENT, { workspaceId, says });
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
        grantCursors: (pass, color) => hub.grantCursors(socket, pass, color),
        revokeCursors: (channel) => hub.revokeCursors(socket, channel),
        evict: (workspaceId, userId) => hub.evict(workspaceId, userId),
        evictEverywhere: (userId) => hub.evictEverywhere(userId),
        evictRoom: (workspaceId) => hub.evictRoom(workspaceId),
        closeSessionsOf: (userId, keepSessionId) => hub.closeSessionsOf(userId, keepSessionId),
        closeSession: (sessionId) => hub.closeSession(sessionId),
        userChanged: (userId, workspaceId, topics, byUserId) => hub.userChanged(userId, workspaceId, topics, byUserId),
        changed: (workspaceId, topics, byUserId) => hub.changed(workspaceId, topics, byUserId),
        resync: (db, workspaceId) => hub.resync(db, workspaceId)
    };
}
