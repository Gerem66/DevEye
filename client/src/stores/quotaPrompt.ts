/**
 * Une commande refusée pour `quota_exceeded`, d'où qu'elle parte : le client WS
 * la signale ici, et l'invite montée par l'accueil la montre. Aucun module n'a
 * à traiter ce refus lui-même.
 */
type Listener = (message: string) => void;

let listener: Listener | null = null;

export function onQuotaExceeded(fn: Listener): () => void {
    listener = fn;
    return () => {
        if (listener === fn) listener = null;
    };
}

export function notifyQuotaExceeded(message: string): void {
    listener?.(message);
}
