import {
    LIVE_CURSORS_EVENT,
    LIVE_PEERS_EVENT,
    livePeersPushSchema,
    liveCursorsPushSchema,
    type LiveCursor,
    type LivePeer
} from '@deveye/types';
import { useSyncExternalStore } from 'react';

import { ws } from '@/api/ws';
import { getActiveWorkspaceId } from './workspace';

/**
 * La présence en direct : publier où je suis (`live.here`, anti-rebondi) et
 * recevoir le roster de la salle avec les curseurs de mes voisins immédiats.
 *
 * Le roster ne porte que `userId` et la couleur ; pseudo et avatar se résolvent
 * contre les membres que la session a déjà livrés (`useActiveWorkspace().users`).
 * Un avatar est une URL de données pouvant atteindre 1,5 Mo, et le roster repart
 * à chaque changement de chemin.
 */

/**
 * L'ordre des niveaux, déclaré plutôt que déduit de l'ordre de montage : les
 * effets React se déclenchent de la feuille vers la racine, ce qui donnerait des
 * chemins à l'envers.
 *
 * Les niveaux sont positionnels et non sémantiques (`l1` = « la chose
 * sélectionnée dans cette feature »), donc n'importe quelle feature entre dans le
 * moteur sans rien ajouter ici. `livePathSchema` en autorise six, mais chaque
 * niveau allonge le chemin diffusé à chaque déplacement.
 */
export const LIVE_SEGMENT_ORDER = ['view', 'l1', 'l2', 'l3', 'l4'] as const;
export type LiveSegmentKind = (typeof LIVE_SEGMENT_ORDER)[number];

/**
 * Ce qui peut porter un halo : les niveaux, plus la coquille de réglages, qui
 * ferme le chemin sans être un niveau (voir `pushLiveSettings`). Un bouton de
 * réglages s'entoure comme n'importe quel autre nœud du chemin.
 */
export type LiveOutlineKind = LiveSegmentKind | 'settings';

export interface LiveCursorEntry {
    connId: string;
    userId: number;
    cursor: LiveCursor;
}

interface LiveState {
    /** Les pairs de ma salle, moi compris. Vide hors espace partagé peuplé. */
    peers: LivePeer[];
    /** Les curseurs des pairs situés exactement là où je suis. */
    cursors: LiveCursorEntry[];
    /** Mon propre chemin publié, pour comparer les chemins des pairs. */
    path: string[];
    /** Où une téléportation en cours veut nous emmener, ou `null`. */
    teleport: LiveTeleport | null;
}

export interface LiveTeleport {
    path: readonly string[];
    /**
     * Les niveaux déjà rejoints. La cible ne les redonne plus : en repartir
     * (refermer la vue, revenir à la liste) est un choix de l'utilisateur, que
     * la téléportation encore en cours ne doit pas défaire.
     */
    reached: ReadonlySet<LiveSegmentKind>;
}

const EMPTY: LiveState = { peers: [], cursors: [], path: [], teleport: null };

let state: LiveState = EMPTY;
const listeners = new Set<() => void>();

function emit(): void {
    for (const fn of listeners) fn();
}

function subscribe(fn: () => void): () => void {
    ensureWired();
    listeners.add(fn);
    return () => {
        listeners.delete(fn);
    };
}

export function getLiveState(): LiveState {
    return state;
}

/**
 * L'état complet, à réserver à ce qui lit vraiment les curseurs : ils arrivent
 * jusqu'à vingt fois par seconde et chaque poussée remplace l'objet d'état, donc
 * tout lecteur de ce hook se réaffiche à cette cadence. Les vues étroites
 * ci-dessous isolent leurs lecteurs.
 */
export function useLive(): LiveState {
    return useSyncExternalStore(subscribe, getLiveState, getLiveState);
}

/** Le roster seul : `state.peers` garde son identité d'une poussée de curseurs à l'autre. */
function getPeers(): LivePeer[] {
    return state.peers;
}

export function usePeers(): LivePeer[] {
    return useSyncExternalStore(subscribe, getPeers, getPeers);
}

/** La téléportation, seule : elle ne bouge qu'à la demande et à chaque niveau rejoint. */
function getTeleport(): LiveTeleport | null {
    return state.teleport;
}

export function useTeleport(): LiveTeleport | null {
    return useSyncExternalStore(subscribe, getTeleport, getTeleport);
}

/**
 * Le couple « qui est là » / « où je suis ». Mémorisé : un objet neuf à chaque
 * appel ferait conclure `useSyncExternalStore` à un changement permanent.
 */
let presenceView: { peers: LivePeer[]; path: string[] } = { peers: EMPTY.peers, path: EMPTY.path };

function getPresence(): { peers: LivePeer[]; path: string[] } {
    if (presenceView.peers !== state.peers || presenceView.path !== state.path) {
        presenceView = { peers: state.peers, path: state.path };
    }
    return presenceView;
}

export function useLivePresence(): { peers: LivePeer[]; path: string[] } {
    return useSyncExternalStore(subscribe, getPresence, getPresence);
}

// ------------------------------------------------------------------ publication

const PUBLISH_DEBOUNCE_MS = 120;

/**
 * Les niveaux déclarés, rangés par vue (`null` : l'accueil, qui déclare `view`).
 * Une vue refermée reste montée un moment, et ses niveaux ne doivent ni entrer
 * dans le chemin publié ni effacer ceux de la vue ouverte. `null` en valeur est
 * un niveau déclaré vide, distinct d'un niveau que personne ne déclare.
 */
const segments = new Map<string | null, Map<LiveSegmentKind, string | null>>();
let publishTimer: ReturnType<typeof setTimeout> | null = null;
let lastSentKey = '';

/**
 * Les coquilles de réglages ouvertes, la dernière au sommet. Une marque de
 * queue plutôt qu'un niveau : la coquille s'ouvre par-dessus n'importe quelle
 * profondeur, et un niveau fixe serait tantôt libre, tantôt déjà pris. En pile
 * parce qu'une coquille d'élément peut s'ouvrir depuis celle de sa
 * fonctionnalité, et que la fermeture de l'une ne doit pas effacer l'autre.
 */
const settingsStack: { token: number; value: string }[] = [];
let settingsToken = 0;

/**
 * Le chemin courant : la vue ouverte puis ses niveaux, dans l'ordre, jusqu'au
 * premier absent (on ne peut pas être dans un dossier sans être dans le compte),
 * puis la coquille de réglages ouverte s'il y en a une.
 */
function buildPath(): string[] {
    const path: string[] = [];
    const view = segments.get(null)?.get('view') ?? null;
    const levels = view === null ? undefined : segments.get(view);
    for (const kind of LIVE_SEGMENT_ORDER) {
        const value = kind === 'view' ? view : (levels?.get(kind) ?? null);
        if (value === null) break;
        path.push(`${kind}:${value}`);
    }
    const top = settingsStack[settingsStack.length - 1];
    if (top) path.push(`settings:${top.value}`);
    return path;
}

/**
 * Ouvre une coquille de réglages dans le chemin diffusé, et rend de quoi la
 * refermer. Régler n'est pas naviguer : sans cette marque, le curseur de qui
 * ouvre les réglages reste groupé avec ceux qui lisent l'écran en dessous.
 */
export function pushLiveSettings(value: string): () => void {
    const token = ++settingsToken;
    settingsStack.push({ token, value });
    schedulePublish();
    return () => {
        const at = settingsStack.findIndex((e) => e.token === token);
        if (at === -1) return;
        settingsStack.splice(at, 1);
        schedulePublish();
    };
}

/** Déclare le niveau `kind` de la vue `scope`, vide avec `null`. */
export function setLiveSegment(scope: string | null, kind: LiveSegmentKind, value: string | null): void {
    let levels = segments.get(scope);
    if (!levels) segments.set(scope, (levels = new Map()));
    if (levels.has(kind) && levels.get(kind) === value) return;
    levels.set(kind, value);
    schedulePublish();
    settleTeleport();
}

/** Retire un niveau que son déclarant quitte, s'il porte encore sa valeur : un autre a pu le reprendre. */
export function clearLiveSegment(scope: string | null, kind: LiveSegmentKind, value: string | null): void {
    const levels = segments.get(scope);
    if (!levels?.has(kind) || levels.get(kind) !== value) return;
    levels.delete(kind);
    if (levels.size === 0) segments.delete(scope);
    schedulePublish();
    settleTeleport();
}

function schedulePublish(): void {
    if (publishTimer) clearTimeout(publishTimer);
    publishTimer = setTimeout(() => {
        publishTimer = null;
        void publishNow();
    }, PUBLISH_DEBOUNCE_MS);
}

/**
 * Envoie `live.here` et applique le roster qu'il renvoie : aucun trou entre
 * l'entrée en salle et la première diffusion, et resynchronisation après une
 * reconnexion.
 */
async function publishNow(): Promise<void> {
    if (ws.state !== 'open') return;
    if (getActiveWorkspaceId() === null) return;

    const path = buildPath();
    // La clé inclut l'espace : le même chemin dans un autre espace est un autre
    // lieu, et doit être republié.
    const key = `${getActiveWorkspaceId()}|${path.join(' ')}`;
    if (key === lastSentKey) return;
    lastSentKey = key;

    try {
        const res = await ws.send('live.here', { path });
        state = { ...state, peers: res.peers, path };
        emit();
    } catch {
        // Socket fermée pendant l'envoi, ou droits refusés : oublier la clé pour
        // que la prochaine tentative reparte, plutôt que rester absent de la salle.
        lastSentKey = '';
    }
}

/** Force une republication (reconnexion, bascule d'espace). */
export function refreshLive(): void {
    lastSentKey = '';
    schedulePublish();
}

// ------------------------------------------------------------------ téléportation

/**
 * Aller là où quelqu'un se trouve. L'intention vit hors de l'arbre React, donc une
 * feature pas encore montée la trouvera en arrivant. Chaque niveau rejoint est
 * acquis ; elle s'efface dès que le chemin publié rejoint la cible, et de toute
 * façon au bout de ce délai : une cible disparue ne doit pas coincer la
 * navigation.
 */
const TELEPORT_TTL_MS = 10_000;

let teleportWorkspaceId: number | null = null;
let teleportTimer: ReturnType<typeof setTimeout> | null = null;

export function startTeleport(workspaceId: number, path: readonly string[]): void {
    teleportWorkspaceId = workspaceId;
    if (teleportTimer) clearTimeout(teleportTimer);
    teleportTimer = setTimeout(clearTeleport, TELEPORT_TTL_MS);
    state = { ...state, teleport: { path: [...path], reached: new Set() } };
    emit();
    settleTeleport();
}

function clearTeleport(): void {
    if (state.teleport === null) return;
    if (teleportTimer) clearTimeout(teleportTimer);
    teleportTimer = null;
    teleportWorkspaceId = null;
    state = { ...state, teleport: null };
    emit();
}

/** Renonce à la téléportation de l'espace actif : sa cible est refusée ici (droits, maintenance). */
export function cancelTeleport(): void {
    if (teleportWorkspaceId !== null && teleportWorkspaceId !== getActiveWorkspaceId()) return;
    clearTeleport();
}

function wantedAt(path: readonly string[], kind: LiveSegmentKind): string | null {
    const prefix = `${kind}:`;
    const wanted = path.find((s) => s.startsWith(prefix));
    return wanted === undefined ? null : wanted.slice(prefix.length);
}

/**
 * Après chaque changement de niveau : un niveau dont le déclarant est sur la
 * valeur visée est acquis, et la téléportation s'achève quand le chemin publié
 * rejoint la cible. Rien ne s'acquiert dans un autre espace que le sien.
 */
function settleTeleport(): void {
    const teleport = state.teleport;
    if (teleport === null) return;
    if (teleportWorkspaceId !== null && teleportWorkspaceId !== getActiveWorkspaceId()) return;
    if (buildPath().join(' ') === teleport.path.join(' ')) {
        clearTeleport();
        return;
    }
    const view = wantedAt(teleport.path, 'view');
    let reached = teleport.reached;
    for (const kind of LIVE_SEGMENT_ORDER) {
        if (reached.has(kind)) continue;
        if (kind !== 'view' && view === null) break;
        const levels = segments.get(kind === 'view' ? null : view);
        if (!levels?.has(kind) || levels.get(kind) !== wantedAt(teleport.path, kind)) continue;
        reached = new Set(reached).add(kind);
    }
    if (reached === teleport.reached) return;
    state = { ...state, teleport: { path: teleport.path, reached } };
    emit();
}

/**
 * Ce qu'une téléportation attend à un niveau donné. `null` = rien de demandé,
 * `{ value: 'mail' }` = il faut y aller, `{ value: null }` = ce niveau doit être
 * refermé. Fonction pure : une feature pas prête la retrouvera au rendu suivant.
 * Sous la racine, seule la vue visée reçoit quelque chose ; un niveau acquis ne
 * reçoit plus rien.
 */
export interface LiveSegmentTarget {
    value: string | null;
}

export function segmentTarget(
    teleport: LiveTeleport | null,
    scope: string | null,
    kind: LiveSegmentKind,
    current: string | null
): LiveSegmentTarget | null {
    if (teleport === null || teleport.reached.has(kind)) return null;
    if (scope !== null && scope !== wantedAt(teleport.path, 'view')) return null;
    const value = wantedAt(teleport.path, kind);
    return value === current ? null : { value };
}

/** Purge à la déconnexion : la session suivante ne doit pas hériter du roster et du chemin. */
export function resetLive(): void {
    clearTeleport();
    segments.clear();
    lastSentKey = '';
    if (publishTimer) clearTimeout(publishTimer);
    publishTimer = null;
    state = EMPTY;
    emit();
}

// ------------------------------------------------------------------ réception

let wired = false;

function ensureWired(): void {
    if (wired) return;
    wired = true;

    ws.onMessage((msg) => {
        if (!msg.payload.ok) return;

        if (msg.command === LIVE_PEERS_EVENT) {
            const push = livePeersPushSchema.safeParse(msg.payload.data);
            // Une trame de l'ancienne salle peut croiser une bascule d'espace :
            // l'appliquer ferait clignoter des pairs qui ne sont plus les miens.
            if (!push.success || push.data.workspaceId !== getActiveWorkspaceId()) return;
            state = { ...state, peers: push.data.peers };
            emit();
            return;
        }

        if (msg.command === LIVE_CURSORS_EVENT) {
            const push = liveCursorsPushSchema.safeParse(msg.payload.data);
            if (!push.success || push.data.workspaceId !== getActiveWorkspaceId()) return;
            state = { ...state, cursors: push.data.cursors };
            emit();
        }
    });

    // Le serveur ne garde rien d'une connexion morte, et l'`outbox` de `ws.send`
    // est vidée à la fermeture : la présence se rétablit ici.
    ws.onStateChange((s) => {
        if (s === 'open') refreshLive();
        else {
            state = { ...state, peers: [], cursors: [] };
            emit();
        }
    });
}
