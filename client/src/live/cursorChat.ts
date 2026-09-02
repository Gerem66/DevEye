import { LIVE_SAY_COMMAND, LIVE_SAYS_EVENT, liveSaysPushSchema, SAY_MAX_LINES } from '@deveye/types';
import { useSyncExternalStore } from 'react';

import { ws } from '@/api/ws';
import { getActiveWorkspaceId } from '@/stores/workspace';

/**
 * La bulle : le texte libre qu'on écrit à son propre curseur, et celui que les
 * pairs du même endroit écrivent au leur. De la présence, pas de la messagerie :
 * rien n'est envoyé ni conservé, la bulle vit tant qu'on la tient ouverte.
 *
 * Le lieu n'est jamais transmis : le serveur ne diffuse qu'aux pairs au même
 * chemin que l'émetteur, et efface la bulle dès qu'il change de lieu.
 */

/**
 * Cadence d'émission. Doit rester nettement au-dessus du plancher du serveur
 * (100 ms, `src/live/hub.ts`), qui laisse tomber ce qui arrive trop vite : une
 * dernière frappe étouffée laisserait la bulle des pairs sur un texte périmé.
 */
const EMIT_FLOOR_MS = 150;

// ------------------------------------------------------------------ réception

interface Say {
    connId: string;
    text: string;
}

let says: Say[] = [];
const listeners = new Set<() => void>();
let wired = false;

function emit(): void {
    for (const fn of listeners) fn();
}

function ensureWired(): void {
    if (wired) return;
    wired = true;
    ws.onMessage((msg) => {
        if (msg.command !== LIVE_SAYS_EVENT || !msg.payload.ok) return;
        const push = liveSaysPushSchema.safeParse(msg.payload.data);
        // Une trame de l'ancienne salle peut croiser une bascule d'espace :
        // l'appliquer afficherait la bulle de pairs qui ne sont plus les miens.
        if (!push.success || push.data.workspaceId !== getActiveWorkspaceId()) return;
        says = push.data.says;
        emit();
    });

    // Le serveur ne garde rien d'une connexion morte, et `ws.post` ne met rien
    // en file : une bulle laissée à l'écran survivrait à la coupure.
    ws.onStateChange((state) => {
        if (state === 'open') return;
        says = [];
        emit();
        closeCursorChat();
    });
}

function subscribe(fn: () => void): () => void {
    ensureWired();
    listeners.add(fn);
    return () => {
        listeners.delete(fn);
    };
}

/** Ce que disent les pairs situés **au même endroit que moi**, par connexion. */
export function useSays(): Say[] {
    return useSyncExternalStore(
        subscribe,
        () => says,
        () => says
    );
}

// ------------------------------------------------------------------ ma bulle

/**
 * La dernière position connue de mon pointeur, alimentée par `LiveProvider`
 * plutôt que par un écouteur de plus : elle sert à poser la saisie sous le
 * curseur à l'ouverture, avant le premier mouvement.
 */
let pointer = { x: 0, y: 0 };

export function rememberPointer(x: number, y: number): void {
    pointer = { x, y };
}

export function lastPointer(): { x: number; y: number } {
    return pointer;
}

interface Composer {
    open: boolean;
    text: string;
}

const CLOSED: Composer = { open: false, text: '' };

let composer: Composer = CLOSED;
const composerListeners = new Set<() => void>();

let sentAt = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
/** Le dernier état posté, pour ne pas répéter une trame identique. */
let lastPosted: string | null = null;

function emitComposer(): void {
    for (const fn of composerListeners) fn();
}

function subscribeComposer(fn: () => void): () => void {
    composerListeners.add(fn);
    return () => {
        composerListeners.delete(fn);
    };
}

/** L'état de ma saisie : ouverte ou non, et ce qu'elle contient. */
export function useCursorChat(): Composer {
    return useSyncExternalStore(
        subscribeComposer,
        () => composer,
        () => composer
    );
}

/**
 * Anti-rebond à front arrière, comme celui des positions de curseur : le
 * dernier état part toujours, quitte à attendre. Étouffer la dernière frappe
 * laisserait les pairs sur un texte périmé, une bulle portant un état et non un
 * événement.
 */
function schedule(): void {
    if (timer !== null) return;
    const wait = Math.max(0, EMIT_FLOOR_MS - (Date.now() - sentAt));
    timer = setTimeout(() => {
        timer = null;
        sentAt = Date.now();
        // La chaîne vide n'est pas une bulle : tant que rien n'est tapé, les
        // pairs ne voient rien.
        const message = composer.open && composer.text.length > 0 ? composer.text : null;
        if (message === lastPosted) return;
        lastPosted = message;
        ws.post(LIVE_SAY_COMMAND, { message });
    }, wait);
}

export function openCursorChat(): void {
    if (composer.open) return;
    composer = { open: true, text: '' };
    emitComposer();
}

/**
 * Le plafond de lignes, appliqué ici plutôt qu'au clavier seul : un collage y
 * passe aussi. La longueur ne suffit pas à borner la hauteur, cent retours à la
 * ligne tenant dans cent caractères.
 */
function clampLines(text: string): string {
    const lines = text.split('\n');
    return lines.length <= SAY_MAX_LINES ? text : lines.slice(0, SAY_MAX_LINES).join('\n');
}

export function setCursorChatText(raw: string): void {
    const text = clampLines(raw);
    if (!composer.open || composer.text === text) return;
    composer = { ...composer, text };
    emitComposer();
    schedule();
}

/** Ferme et efface. Le retrait part tout de suite : on ne fait pas attendre un silence. */
export function closeCursorChat(): void {
    if (composer === CLOSED) return;
    composer = CLOSED;
    emitComposer();
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (lastPosted === null) return;
    lastPosted = null;
    sentAt = Date.now();
    ws.post(LIVE_SAY_COMMAND, { message: null });
}
