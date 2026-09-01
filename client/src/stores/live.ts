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
    teleportPath: string[] | null;
}

const EMPTY: LiveState = { peers: [], cursors: [], path: [], teleportPath: null };

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

/** La cible d'une téléportation, seule : elle ne bouge qu'à la demande. */
function getTeleportPath(): string[] | null {
    return state.teleportPath;
}

export function useTeleportPath(): string[] | null {
    return useSyncExternalStore(subscribe, getTeleportPath, getTeleportPath);
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

const segments = new Map<LiveSegmentKind, string>();
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
 * Le chemin courant : les niveaux déclarés, dans l'ordre, jusqu'au premier absent
 * (on ne peut pas être dans un dossier sans être dans le compte), puis la
 * coquille de réglages ouverte s'il y en a une.
 */
function buildPath(): string[] {
    const path: string[] = [];
    for (const kind of LIVE_SEGMENT_ORDER) {
        const value = segments.get(kind);
        if (value === undefined) break;
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

/** Déclare un niveau, ou le retire avec `null`. */
export function setLiveSegment(kind: LiveSegmentKind, value: string | null): void {
    const before = segments.get(kind);
    if (value === null) {
        if (before === undefined) return;
        segments.delete(kind);
    } else {
        if (before === value) return;
        segments.set(kind, value);
    }
    schedulePublish();
    maybeCompleteTeleport();
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
 * feature pas encore montée la trouvera en arrivant. Elle s'efface dès que le
 * chemin publié rejoint la cible, et de toute façon au bout de ce délai : une
 * cible disparue ne doit pas coincer la navigation.
 */
const TELEPORT_TTL_MS = 10_000;

let teleportWorkspaceId: number | null = null;
let teleportTimer: ReturnType<typeof setTimeout> | null = null;

export function startTeleport(workspaceId: number, path: readonly string[]): void {
    teleportWorkspaceId = workspaceId;
    if (teleportTimer) clearTimeout(teleportTimer);
    teleportTimer = setTimeout(clearTeleport, TELEPORT_TTL_MS);
    state = { ...state, teleportPath: [...path] };
    emit();
    maybeCompleteTeleport();
}

function clearTeleport(): void {
    if (state.teleportPath === null) return;
    if (teleportTimer) clearTimeout(teleportTimer);
    teleportTimer = null;
    teleportWorkspaceId = null;
    state = { ...state, teleportPath: null };
    emit();
}

/** Appelé après chaque changement de niveau : la cible est atteinte, ou
 *  l'utilisateur est parti ailleurs de lui-même. */
function maybeCompleteTeleport(): void {
    const target = state.teleportPath;
    if (target === null) return;
    if (teleportWorkspaceId !== null && teleportWorkspaceId !== getActiveWorkspaceId()) return;
    if (buildPath().join(' ') === target.join(' ')) clearTeleport();
}

/**
 * Ce qu'une téléportation attend à un niveau donné. `null` = rien de demandé,
 * `{ value: 'mail' }` = il faut y aller, `{ value: null }` = ce niveau doit être
 * refermé. Fonction pure : une feature pas prête la retrouvera au rendu suivant.
 */
export interface LiveSegmentTarget {
    value: string | null;
}

export function segmentTarget(
    teleportPath: readonly string[] | null,
    kind: LiveSegmentKind,
    current: string | null
): LiveSegmentTarget | null {
    if (teleportPath === null) return null;
    const prefix = `${kind}:`;
    const wanted = teleportPath.find((s) => s.startsWith(prefix));
    const value = wanted === undefined ? null : wanted.slice(prefix.length);
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
