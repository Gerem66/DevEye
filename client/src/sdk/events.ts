import type { ZodType } from 'zod';

import { ws } from '@/api/ws';

/**
 * Les primitives d'événements serveur du SDK client.
 *
 * Un module ne voit jamais la socket brute : il s'abonne à UN événement typé,
 * et à la réouverture de la connexion. C'est tout ce que les flux poussés
 * demandent (progression, état, chunks de téléchargement), et c'est ce qui
 * permet à la socket de rester interne (reconnexion, enveloppes, file
 * d'attente : rien de tout ça n'est un contrat).
 */

/**
 * Abonne `cb` aux trames poussées `event`. Le payload est validé par `schema` ;
 * une trame qui ne colle pas est ignorée (un serveur plus récent peut pousser
 * plus que ce que ce client connaît). Rend le désabonnement.
 */
export function onServerEvent<T>(event: string, schema: ZodType<T>, cb: (payload: T) => void): () => void {
    return ws.onMessage((msg) => {
        if (msg.command !== event || !msg.payload.ok) return;
        const parsed = schema.safeParse(msg.payload.data);
        if (parsed.success) cb(parsed.data);
    });
}

/**
 * Appelle `cb` maintenant si la socket est ouverte, puis à CHAQUE réouverture :
 * la primitive « réabonne-toi après une coupure ». Rend le désabonnement.
 */
export function onSocketOpen(cb: () => void): () => void {
    if (ws.state === 'open') cb();
    return ws.onStateChange((state) => {
        if (state === 'open') cb();
    });
}
