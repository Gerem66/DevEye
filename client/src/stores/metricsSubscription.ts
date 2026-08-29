import { ws } from '@/api/ws';

/**
 * Client-side ref-counting for live metric subscriptions. The server hub keys
 * subscriptions by socket and the client has a single one, so two consumers of the
 * same device using raw `agent.subscribe`/`unsubscribe` would unsubscribe each
 * other. Routing every subscriber through this store coalesces them, and
 * everything is re-subscribed when the socket reopens.
 */
const refCounts = new Map<string, number>();
let offState: (() => void) | null = null;

function sendSubscribe(deviceId: string): void {
    if (ws.state === 'open') ws.send('agent.subscribe', { deviceIds: [deviceId] }).catch(() => {});
}

function sendUnsubscribe(deviceId: string): void {
    if (ws.state === 'open') ws.send('agent.unsubscribe', { deviceIds: [deviceId] }).catch(() => {});
}

function ensureStateSub(): void {
    if (offState) return;
    offState = ws.onStateChange((s) => {
        if (s === 'open') for (const id of refCounts.keys()) sendSubscribe(id);
    });
}

/**
 * Acquire a live subscription to `deviceId`. Returns a release function; call it
 * once (e.g. from a `useEffect` cleanup) when the consumer goes away.
 */
export function acquireMetrics(deviceId: string): () => void {
    const next = (refCounts.get(deviceId) ?? 0) + 1;
    refCounts.set(deviceId, next);
    ensureStateSub();
    // Envoyé à chaque prise et pas seulement à la première : le serveur répond par
    // le dernier instant enregistré, sans quoi un second consommateur resterait sans
    // valeur jusqu'à la poussée suivante. L'abonnement y est un ensemble.
    sendSubscribe(deviceId);

    let released = false;
    return () => {
        if (released) return;
        released = true;
        const count = (refCounts.get(deviceId) ?? 1) - 1;
        if (count <= 0) {
            refCounts.delete(deviceId);
            sendUnsubscribe(deviceId);
            if (refCounts.size === 0 && offState) {
                offState();
                offState = null;
            }
        } else {
            refCounts.set(deviceId, count);
        }
    };
}
