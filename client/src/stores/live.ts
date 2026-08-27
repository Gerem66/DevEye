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
 * La présence en direct, côté client.
 *
 * Deux responsabilités qui partagent le même abonnement :
 *  - **publier** où je suis (`live.here`, anti-rebondi) ;
 *  - **recevoir** le roster de la salle et les curseurs de mes voisins immédiats.
 *
 * Le pseudo et l'avatar d'un pair ne viennent pas d'ici : le roster ne porte que
 * `userId` et la couleur, et le reste se résout contre les membres de l'espace
 * que la session a déjà livrés (`useActiveWorkspace().users`). Un avatar est une
 * URL de données pouvant atteindre 1,5 Mo — le roster repart à chaque changement
 * de chemin, il ne peut pas les transporter.
 */

/**
 * L'ordre des niveaux, **déclaré** plutôt que déduit de l'ordre de montage.
 *
 * Les effets React se déclenchent de la feuille vers la racine : s'en remettre à
 * l'ordre de montage donnerait des chemins à l'envers. Un ordre global fixe dit
 * la même chose sans aucune fragilité.
 *
 * Les niveaux sont **positionnels et non sémantiques** — `l1`, `l2`, `l3` plutôt
 * que `account`, `folder`, `message`. C'est ce qui permet à n'importe quelle
 * feature d'entrer dans le moteur sans rien ajouter ici : `l1` est « la chose
 * sélectionnée dans cette feature », que ce soit une boîte mail, un service
 * surveillé, une ville ou un appareil. Des noms sémantiques auraient obligé à
 * étendre cette liste par feature, et surtout à décider où insérer `service`
 * par rapport à `folder` — une question qui n'a pas de réponse.
 *
 * Aucun risque de confusion entre features : les niveaux ne sont comparés
 * qu'après un préfixe commun, lequel commence toujours par `view:<feature>`.
 *
 * Cinq niveaux, parce que la feature la plus profonde en compte cinq : Projets
 * descend jusqu'à l'onglet d'une tâche (`view:projects l1:<id> l2:tab
 * l3:card l4:tab`). Le contrat du fil en autorise six (`livePathSchema`), il
 * reste donc de la marge — mais en ajouter un ici a un coût réel : chaque
 * niveau allonge le chemin diffusé à chaque déplacement, et affine le
 * regroupement des curseurs. On n'en ajoute que pour un lieu où deux personnes
 * peuvent réellement se croiser.
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
 * L'état complet. **À réserver à ce qui lit vraiment les curseurs.**
 *
 * Les curseurs arrivent jusqu'à vingt fois par seconde, et chaque poussée
 * remplace l'objet d'état : tout lecteur de ce hook se réaffiche donc à cette
 * cadence, même s'il ne regarde que le roster. C'est ce qui faisait « sauter des
 * trames » sur les écrans de listes — le portefeuille des projets, les dépôts,
 * les bases, les appareils — dès qu'un pair bougeait sa souris quelque part
 * dans l'espace.
 *
 * Les vues étroites ci-dessous existent pour ça : `useSyncExternalStore` ne
 * redessine que si l'instantané change au sens de `Object.is`, donc une tranche
 * dont l'identité ne bouge pas isole ses lecteurs des poussées qui ne les
 * concernent pas.
 */
export function useLive(): LiveState {
    return useSyncExternalStore(subscribe, getLiveState, getLiveState);
}

/**
 * Le roster seul.
 *
 * `state.peers` garde son identité d'une poussée de curseurs à l'autre (l'état
 * est recopié en surface), donc aucun rendu n'est déclenché tant que la
 * composition de la salle ne change pas.
 */
function getPeers(): LivePeer[] {
    return state.peers;
}

export function usePeers(): LivePeer[] {
    return useSyncExternalStore(subscribe, getPeers, getPeers);
}

/** La cible d'une téléportation, seule — elle ne bouge qu'à la demande. */
function getTeleportPath(): string[] | null {
    return state.teleportPath;
}

export function useTeleportPath(): string[] | null {
    return useSyncExternalStore(subscribe, getTeleportPath, getTeleportPath);
}

/**
 * Le couple « qui est là » / « où je suis » : ce dont les contours ont besoin.
 *
 * Mémorisé parce qu'il faut rendre un objet : sans ce cache, chaque appel en
 * fabriquerait un nouveau et `useSyncExternalStore` conclurait à un changement
 * à chaque vérification — exactement le rendu permanent qu'on cherche à éviter.
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
 * Le chemin courant : les niveaux déclarés, dans l'ordre, **jusqu'au premier
 * absent**. Un niveau sans valeur ferme le chemin — on ne peut pas être dans un
 * dossier sans être dans le compte qui le contient.
 */
function buildPath(): string[] {
    const path: string[] = [];
    for (const kind of LIVE_SEGMENT_ORDER) {
        const value = segments.get(kind);
        if (value === undefined) break;
        path.push(`${kind}:${value}`);
    }
    return path;
}

/** Déclare (ou retire) un niveau. Renvoie `true` si le chemin a bougé. */
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
 * Envoie `live.here` et applique l'instantané qu'il renvoie.
 *
 * La réponse porte le roster : il n'y a donc aucun trou entre l'entrée en salle
 * et la première diffusion, et cet unique appel est aussi ce qui resynchronise
 * après une reconnexion.
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
        // Socket fermée pendant l'envoi, ou droits refusés : on oublie la clé
        // pour que la prochaine tentative reparte, plutôt que de rester
        // silencieusement absent de la salle.
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
 * Aller là où quelqu'un se trouve.
 *
 * L'intention vit **hors de l'arbre React**, dans ce singleton, et n'entre dans
 * l'état que pour être lue au rendu. C'est ce qui dispense de tout
 * ordonnancement : une feature pas encore montée n'a rien à rattraper, elle
 * trouvera l'intention en arrivant.
 *
 * Elle s'efface d'elle-même dès que le chemin publié rejoint la cible, et au
 * bout de dix secondes quoi qu'il arrive — sans quoi une cible disparue (un
 * compte mail supprimé entre-temps) laisserait la navigation coincée.
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

/**
 * Appelé après chaque changement de niveau. Deux conditions d'arrêt : la cible
 * est atteinte, ou l'utilisateur est parti ailleurs de lui-même.
 */
function maybeCompleteTeleport(): void {
    const target = state.teleportPath;
    if (target === null) return;
    if (teleportWorkspaceId !== null && teleportWorkspaceId !== getActiveWorkspaceId()) return;
    if (buildPath().join(' ') === target.join(' ')) clearTeleport();
}

/**
 * Ce qu'une téléportation attend à un niveau donné.
 *
 * `null` = rien de demandé ici. `{ value: 'mail' }` = il faut y aller.
 * `{ value: null }` = ce niveau doit être **refermé** — c'est ainsi qu'on
 * exprime « rejoindre quelqu'un qui est à l'accueil », qu'un simple segment ne
 * saurait dire.
 *
 * Fonction **pure** : elle ne consomme rien. Une feature qui n'est pas prête à
 * l'appliquer la retrouvera au rendu suivant, sans avoir rien à acquitter.
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

/**
 * Purge à la déconnexion. Sans ça la session suivante — un autre compte sur la
 * même machine — hériterait du roster et du chemin de la précédente.
 */
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

    // La socket se reconnaît seule (backoff, retour de focus) et le serveur ne
    // garde rien d'une connexion morte : c'est ici que la présence se rétablit.
    // L'`outbox` de `ws.send` ne peut pas s'en charger — elle est vidée à la
    // fermeture, précisément pour que rien de périmé ne reparte.
    ws.onStateChange((s) => {
        if (s === 'open') refreshLive();
        else {
            state = { ...state, peers: [], cursors: [] };
            emit();
        }
    });
}
