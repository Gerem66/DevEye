import type { WebSocket } from '@fastify/websocket';
import { randomUUID } from 'crypto';
import {
    LIVE_CHANGED_EVENT,
    LIVE_CURSORS_EVENT,
    LIVE_PEERS_EVENT,
    LIVE_TYPERS_EVENT,
    livePathGate,
    ok,
    SHARE_WIRED_FEATURES,
    TOPIC_FEATURE,
    type FeatureAccess,
    type LiveCursor,
    type LivePath,
    type LivePeer,
    type LiveTopic,
    type ServerMessage,
    type UserColor,
    type WorkspaceFeatureId
} from 'deveye-types';

import { accessEpochNow, permissionsFor } from '@/features/_access';
import { logger } from '@/logger';
import type { Database } from '@/db';

/**
 * Le moteur de présence en direct : qui est connecté, où, et ce qui change.
 *
 * L'état est local au processus, exactement comme {@link MonitorHub}. Pour un
 * déploiement multi-instance il faudrait passer par un pub/sub partagé, mais
 * l'interface est volontairement étroite pour que ce remplacement reste isolé.
 *
 * Trois responsabilités, une seule structure parce qu'elles partagent le même
 * index (qui est dans quelle salle) :
 *
 *  1. le **roster** — les pairs d'un espace et leur lieu ;
 *  2. les **curseurs** — entre pairs situés au même lieu exactement ;
 *  3. les **changements** — « quelque chose a bougé, re-sollicitez ».
 */

/** Période du balayage de vivacité. Deux tours sans `pong` ferment la socket. */
const HEARTBEAT_MS = 30_000;

/** Regroupement des diffusions : une seule vidange pour toutes les salles. */
const FLUSH_MS = 50;

/**
 * Plancher entre deux `live.changed` de même (espace, sujet).
 *
 * **Doit rester strictement inférieur à l'anti-rebond du client** (250 ms, voir
 * `stores/invalidation.ts`) : une écriture dont la trame est étouffée ici doit
 * malgré tout être visible par la re-sollicitation que la trame précédente a
 * déjà programmée. Remonter cette valeur au-dessus de 250 ms ouvrirait une
 * fenêtre où une écriture ne serait jamais vue.
 */
const TOPIC_FLOOR_MS = 200;

/** Débit maximal accepté d'un client sur la voie rapide des curseurs. */
const CURSOR_FLOOR_MS = 25;

/** Trames de curseur hors cadence tolérées avant de fermer la socket. */
const CURSOR_STRIKES_MAX = 200;

/**
 * Durée de vie d'un « en train d'écrire » sans rafraîchissement.
 *
 * Le client réaffirme sa frappe périodiquement ; passé ce délai sans nouvelle,
 * le pair cesse d'être annoncé. C'est ce qui garantit qu'un onglet fermé
 * brutalement — ou un client fautif — ne laisse pas un fantôme à l'écran.
 */
const TYPING_TTL_MS = 6_000;

/** Cadence du balayage de péremption, actif seulement pendant qu'on écrit. */
const TYPING_SWEEP_MS = 1_000;

/** Débit maximal accepté sur la voie rapide de la frappe. */
const TYPING_FLOOR_MS = 250;

/** Au-delà, la socket est en retard : on laisse tomber la trame de curseur. */
const BACKPRESSURE_BYTES = 64 * 1024;

interface Grants {
    features: ReadonlyMap<WorkspaceFeatureId, FeatureAccess>;
    /** Époque d'accès sous laquelle ces droits ont été résolus. */
    epoch: number;
}

export interface LiveConn {
    /**
     * Identité de la **socket**. `sessionId` (le `sid` du JWT) est partagé par
     * les onglets d'une même session : deux onglets sont deux connexions, deux
     * curseurs, un seul `sessionId`.
     */
    readonly connId: string;
    readonly socket: WebSocket;
    readonly userId: number;
    readonly sessionId: string;
    readonly joinedAt: number;

    /**
     * Salle courante. `null` tant qu'aucun `live.here` n'a abouti : la connexion
     * est alors connue du hub — donc surveillée par le battement de cœur — mais
     * n'appartient à aucune salle.
     */
    workspaceId: number | null;
    path: LivePath;
    color: UserColor | null;

    /**
     * Échéance du « en train d'écrire » de cette connexion, en millisecondes
     * épochales. `0` = n'écrit pas. Une échéance plutôt qu'un booléen : la
     * péremption devient un simple test au moment de diffuser, sans minuteur
     * par connexion à annuler.
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
     * Droits résolus par le dispatcheur, **par espace** — une même connexion en
     * détient légitimement pour sa salle partagée et pour son espace personnel,
     * à cause de `scope: 'account'`.
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
    //
    // À appeler partout où `invalidateAccess()` l'est déjà. Cette dernière ne
    // fait qu'incrémenter un compteur relu par la *commande suivante* : une
    // connexion assise dans une salle n'en émet pas forcément, et continuerait
    // sinon de recevoir curseurs et changements indéfiniment.

    /** Un compte perd l'accès à un espace : il sort de sa salle. */
    evict(workspaceId: number, userId: number): void;
    /** Le compte est suspendu ou supprimé : il sort de toutes les salles. */
    evictEverywhere(userId: number): void;
    /** L'espace disparaît : tout le monde sort. */
    evictRoom(workspaceId: number): void;
    /**
     * Un rôle a changé sans que personne ne perde l'espace : les droits sont
     * re-résolus sur place. Sans ça les membres présents verraient tous leurs
     * pairs « ailleurs » jusqu'à leur prochaine commande.
     */
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
     * feature — posé par `app.ts` (`db.itemSharing.linkedWorkspaces`).
     *
     * C'est ce qui fait TRAVERSER la projection à la diffusion : chaque
     * `changed` sur un sujet de feature branchée au partage est rejoué dans les
     * espaces reliés. Le point est d'être ICI et pas chez les appelants — le
     * dispatcheur, cinq services de fond, le moteur de sauvegardes appellent
     * tous `changed`, et aucun n'a à connaître la règle.
     */
    private shareLinks: ((workspaceId: number, feature: string) => Promise<number[]>) | null = null;

    /** Branche le résolveur d'espaces reliés. Sans lui, aucune traversée. */
    setShareLinks(resolver: (workspaceId: number, feature: string) => Promise<number[]>): void {
        this.shareLinks = resolver;
    }

    private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

    // ---------------------------------------------------------------- cycle de vie

    /**
     * Inscrit une connexion `/ws`, **avant tout `live.here`**. C'est délibéré :
     * sans ça le battement de cœur ne couvrirait que les utilisateurs ayant
     * ouvert une vue instrumentée, et les sockets zombies des autres — un
     * portable mis en veille — resteraient invisibles.
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
                // Pas de `close()` : une socket dont la pile TCP est morte ne
                // verra jamais la poignée de fermeture, et resterait un fantôme
                // dans le roster jusqu'au délai système.
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
     * Entrée en salle. **Déplacement, jamais ajout** : une connexion n'est dans
     * qu'une salle à la fois.
     *
     * C'est ce qui rend la bascule d'espace sûre. `ws.send` estampille
     * l'enveloppe au moment de l'envoi et non de l'appel, donc un `live.here`
     * resté en file d'attente peut arriver avec le nouvel espace ; un hub qui
     * ajouterait sans retirer laisserait un fantôme permanent dans l'ancienne.
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
     * Sortie forcée d'un compte d'une salle, après retrait d'accès.
     *
     * Indispensable : `invalidateAccess()` n'incrémente qu'un compteur relu par
     * la *commande suivante*, or une connexion déjà assise dans une salle n'en
     * émet pas forcément — elle continuerait de recevoir curseurs et
     * changements indéfiniment.
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

    // ---------------------------------------------------------------- droits

    /**
     * Instantané des droits, posé par le dispatcheur à chaque commande.
     *
     * Les droits sont retenus ici plutôt que ré-résolus au moment de diffuser :
     * `forWorkspace()` rend une promesse qui peut *rejeter* (compte suspendu),
     * et un rejet dans un minuteur est un rejet non traité. Ainsi la diffusion
     * reste entièrement synchrone, et n'importe quelle commande répare l'état.
     */
    rememberGrants(
        socket: WebSocket,
        workspaceId: number,
        features: ReadonlyMap<WorkspaceFeatureId, FeatureAccess>,
        epoch: number
    ): void {
        const conn = this.bySocket.get(socket);
        if (!conn) return;
        conn.grants.set(workspaceId, { features, epoch });
    }

    /**
     * Re-résout les droits de toute une salle, après un changement de rôle.
     *
     * Un rôle rétréci n'est pas une exclusion : le membre reste dans la salle,
     * mais ce qu'il a le droit d'y voir change. Sans ce rappel ses droits
     * resteraient périmés — donc fermés — jusqu'à sa prochaine commande, et il
     * verrait tous ses pairs « ailleurs » en attendant.
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

    private canRead(conn: LiveConn, workspaceId: number, feature: WorkspaceFeatureId): boolean {
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

        // Puis les espaces reliés par des projections, pour les sujets qui s'y
        // prêtent : une sonde qui écrit chez elle doit rafraîchir ses fenêtres,
        // une écriture faite depuis une fenêtre doit rafraîchir le domicile.
        // Asynchrone et sans attente : la diffusion locale ne dépend jamais
        // d'une requête de plus, et un échec ici ne casse rien — il retarde.
        if (this.shareLinks === null) return;
        for (const topic of topics) {
            const feature = TOPIC_FEATURE[topic];
            if (feature === null || !SHARE_WIRED_FEATURES.includes(feature)) continue;
            void this.shareLinks(workspaceId, feature)
                .then((linked) => {
                    for (const other of linked) {
                        if (other !== workspaceId) this.changedHere(other, [topic], byUserId, exclude);
                    }
                })
                .catch(() => {
                    // Un raté de résolution retarde un rafraîchissement, il ne
                    // mérite pas de bruit : la prochaine écriture repassera.
                });
        }
    }

    /** La diffusion dans UN espace — le corps historique de `changed`. */
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

    private canSeeTopic(conn: LiveConn, workspaceId: number, topic: LiveTopic): boolean {
        const feature = TOPIC_FEATURE[topic];
        // `null` = aucun droit de feature à vérifier, l'appartenance suffit.
        return feature === null || this.canRead(conn, workspaceId, feature);
    }

    /**
     * Un compte vient de changer de couleur : toutes ses connexions la portent,
     * dans toutes leurs salles. Le roster est la seule voie de propagation —
     * la copie que la session a livrée au client est périmée jusqu'au prochain
     * `/me`, celle du roster est vivante.
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
     * Voie rapide : une position, sans réponse, sans validation d'autorisation.
     *
     * **L'espace de l'enveloppe est délibérément ignoré.** Il est contrôlé par le
     * client et n'est validé que dans `access.forWorkspace()`, que cette voie
     * court-circuite : s'y fier laisserait n'importe qui injecter son curseur
     * dans la salle d'autrui. Seul `conn.workspaceId` fait foi, et il n'a pu
     * être posé que par un `live.here` passé, lui, par le dispatcheur.
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
     * Voie rapide : « j'écris » / « j'ai fini », sans réponse.
     *
     * Mêmes précautions que {@link cursor}. **L'espace de l'enveloppe est ignoré**
     * — il est contrôlé par le client et n'est validé que dans
     * `access.forWorkspace()`, que cette voie court-circuite. Seul
     * `conn.workspaceId` fait foi, et il n'a pu être posé que par un `live.here`
     * passé, lui, par le dispatcheur.
     *
     * La trame ne dit pas *où* : le lieu vient du dernier `live.here`, donc un
     * pair ne peut annoncer sa frappe que là où il se trouve réellement.
     */
    typing(socket: WebSocket, typing: boolean): void {
        const conn = this.bySocket.get(socket);
        if (!conn || conn.workspaceId === null) return;

        const now = Date.now();
        // Étouffement simple plutôt que compteur de fautes : la frappe est une
        // trame rare (début, fin, et un rappel toutes les quelques secondes),
        // l'ignorer suffit à la borner.
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
     * Balayage de péremption, **vivant seulement pendant qu'on écrit**.
     *
     * Sans lui, un pair qui s'arrête net (onglet tué, réseau coupé) resterait
     * annoncé jusqu'à la prochaine diffusion fortuite. Un seul minuteur pour
     * tout le moteur, qui s'éteint dès que plus personne n'écrit — c'est ce qui
     * évite de payer une cadence permanente pour un cas rare.
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
     * Coût : pairs × destinataires, avec une troncature par destinataire. Une
     * salle compte une poignée de membres, et rien n'est calculé tant que rien
     * ne bouge. Si des salles à plusieurs dizaines de membres apparaissaient, ce
     * serait l'endroit à mémoïser par signature de droits.
     */
    private projectRoster(room: Set<LiveConn>, recipient: LiveConn): LivePeer[] {
        const wsId = recipient.workspaceId;
        if (wsId === null) return [];
        const peers: LivePeer[] = [];
        for (const peer of room) {
            // Une connexion n'entre en salle que par `here`, qui pose toujours
            // la couleur : ce filtre ne retient rien en pratique, il évite juste
            // d'inventer une couleur de repli qui masquerait un défaut.
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
     * Le chemin d'un pair tel que ce destinataire a le droit de le voir.
     *
     * Seule la **racine** est examinée : un segment plus profond appartient par
     * construction à la même feature que sa racine, donc qui peut voir la racine
     * peut voir la suite. Les vues de compte et d'administration (Profil,
     * Sécurité, Journaux, Utilisateurs, Gestion de l'espace) sont `private` et
     * ne sont montrées à personne — « Gerem est dans Sécurité » n'a à fuiter
     * vers personne, pas même vers un administrateur.
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
                // Une liste vide n'est envoyée qu'à qui en avait une : sans ça
                // le dernier curseur d'un pair parti resterait à l'écran, mais
                // l'envoyer à tout le monde à chaque mouvement serait du bruit.
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
                // Une liste vide n'est envoyée qu'à qui en avait une : sinon la
                // mention du dernier partant resterait affichée, mais l'envoyer
                // à tout le monde à chaque frappe serait du bruit.
                if (typers.length === 0 && !recipient.hasTypingPeers) continue;
                recipient.hasTypingPeers = typers.length > 0;
                this.send(recipient, LIVE_TYPERS_EVENT, { workspaceId, typers });
            }
        }
    }

    /**
     * Un envoi ne doit jamais lever : le dispatcheur diffuse depuis l'intérieur
     * du `try` d'une commande déjà répondue, et une exception y transformerait
     * un succès en second message d'erreur.
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
        resync: (db, workspaceId) => hub.resync(db, workspaceId)
    };
}
