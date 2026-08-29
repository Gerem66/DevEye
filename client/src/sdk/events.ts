import type { ZodType } from 'zod';

import { ws } from '@/api/ws';

/**
 * Les primitives d'événements serveur du SDK client. Un module ne voit jamais la
 * socket brute : il s'abonne à un événement typé et à la réouverture de la
 * connexion, ce qui suffit aux flux poussés et laisse la reconnexion, les
 * enveloppes et la file d'attente hors contrat.
 */

/**
 * Abonne `cb` aux trames poussées `event`, validées par `schema` ; une trame qui
 * ne colle pas est ignorée, un serveur plus récent pouvant pousser plus que ce
 * client ne connaît. Rend le désabonnement.
 */
export function onServerEvent<T>(event: string, schema: ZodType<T>, cb: (payload: T) => void): () => void {
    return ws.onMessage((msg) => {
        if (msg.command !== event || !msg.payload.ok) return;
        const parsed = schema.safeParse(msg.payload.data);
        if (parsed.success) cb(parsed.data);
    });
}

/**
 * Appelle `cb` maintenant si la socket est ouverte, puis à chaque réouverture :
 * la primitive « réabonne-toi après une coupure ». Rend le désabonnement.
 */
export function onSocketOpen(cb: () => void): () => void {
    if (ws.state === 'open') cb();
    return ws.onStateChange((state) => {
        if (state === 'open') cb();
    });
}

/** La socket est-elle ouverte, pour distinguer une vraie erreur d'une coupure. */
export function isSocketOpen(): boolean {
    return ws.state === 'open';
}
