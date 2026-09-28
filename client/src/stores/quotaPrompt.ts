/**
 * Une commande refusée pour `quota_exceeded`, d'où qu'elle parte : le client WS
 * la signale ici, et l'invite montée par l'accueil la montre. Aucun module n'a
 * à traiter ce refus lui-même.
 */
/**
 * `paused` : l'élément visé est en pause, et non une création refusée.
 * `priority` : le refus vient de la priorité aux abonnés, pas de l'offre.
 */
type Listener = (message: string, paused: boolean, priority: boolean) => void;

let listener: Listener | null = null;

export function onQuotaExceeded(fn: Listener): () => void {
    listener = fn;
    return () => {
        if (listener === fn) listener = null;
    };
}

export function notifyQuotaExceeded(message: string, paused = false, priority = false): void {
    listener?.(message, paused, priority);
}
