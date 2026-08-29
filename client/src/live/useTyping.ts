import { LIVE_TYPERS_EVENT, LIVE_TYPING_COMMAND, liveTypersPushSchema } from '@deveye/types';
import { useEffect, useRef, useSyncExternalStore } from 'react';

import { ws } from '@/api/ws';
import { getActiveWorkspaceId } from '@/stores/workspace';

/**
 * « Untel est en train d'écrire… », côté client. Deux moitiés séparées, une
 * feature pouvant n'avoir besoin que de l'une : {@link useTypingSignal} annonce
 * ma frappe, {@link useTypers} écoute celle des autres.
 *
 * Le lieu n'est jamais transmis : le serveur ne diffuse la frappe qu'aux pairs au
 * même chemin que l'émetteur, donc déclarer `useLiveSegment` suffit à cadrer qui
 * verra quoi.
 */

/**
 * Cadence de rappel de « j'écris toujours ». Doit rester nettement sous la
 * péremption du serveur (6 s, voir `src/live/hub.ts`), sinon l'indicateur
 * clignoterait entre deux rappels.
 */
const HEARTBEAT_MS = 2_500;

/**
 * Silence au bout duquel la frappe est considérée comme arrêtée. Sans lui,
 * quitter le champ sans le vider laisserait le pair annoncé jusqu'à la péremption
 * serveur.
 */
const IDLE_MS = 3_000;

interface Typer {
    connId: string;
    userId: number;
}

let typers: Typer[] = [];
const listeners = new Set<() => void>();
let wired = false;

function emit(): void {
    for (const fn of listeners) fn();
}

function ensureWired(): void {
    if (wired) return;
    wired = true;
    ws.onMessage((msg) => {
        if (msg.command !== LIVE_TYPERS_EVENT || !msg.payload.ok) return;
        const push = liveTypersPushSchema.safeParse(msg.payload.data);
        // Une trame de l'ancienne salle peut croiser une bascule d'espace :
        // l'appliquer afficherait la frappe de pairs qui ne sont plus les miens.
        if (!push.success || push.data.workspaceId !== getActiveWorkspaceId()) return;
        typers = push.data.typers;
        emit();
    });
}

function subscribe(fn: () => void): () => void {
    ensureWired();
    listeners.add(fn);
    return () => {
        listeners.delete(fn);
    };
}

/** Les pairs en train d'écrire **au même endroit que moi**. */
export function useTypers(): Typer[] {
    return useSyncExternalStore(
        subscribe,
        () => typers,
        () => typers
    );
}

/**
 * Annonce ma frappe. Appeler `onInput()` à chaque touche : le rappel périodique
 * et l'arrêt après un silence sont gérés ici, et `stop()` coupe immédiatement. Un
 * composant qui disparaît en cours de frappe ne laisse pas son annonce derrière.
 */
export function useTypingSignal(): { onInput: () => void; stop: () => void } {
    const typing = useRef(false);
    const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const beatTimer = useRef<ReturnType<typeof setInterval> | null>(null);

    const api = useRef({
        onInput: () => {},
        stop: () => {}
    });

    useEffect(() => {
        const post = (value: boolean) => {
            // `ws.post` et non `ws.send` : trame sans réponse, sans promesse en
            // attente ni délai de 15 s.
            ws.post(LIVE_TYPING_COMMAND, { typing: value });
        };

        const stop = () => {
            if (idleTimer.current) clearTimeout(idleTimer.current);
            if (beatTimer.current) clearInterval(beatTimer.current);
            idleTimer.current = null;
            beatTimer.current = null;
            if (!typing.current) return;
            typing.current = false;
            post(false);
        };

        const onInput = () => {
            if (!typing.current) {
                typing.current = true;
                post(true);
                beatTimer.current = setInterval(() => post(true), HEARTBEAT_MS);
            }
            if (idleTimer.current) clearTimeout(idleTimer.current);
            idleTimer.current = setTimeout(stop, IDLE_MS);
        };

        api.current = { onInput, stop };
        return stop;
    }, []);

    return {
        onInput: () => api.current.onInput(),
        stop: () => api.current.stop()
    };
}
