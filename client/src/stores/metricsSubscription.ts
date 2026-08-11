import { ws } from '@/api/ws';

/**
 * Client-side ref-counting for live metric subscriptions.
 *
 * The server hub keys subscriptions by *socket* (`src/agent/hub.ts`), and the
 * client has a single `/ws` socket. If two consumers (e.g. the full Monitoring
 * view and a device popup, both kept alive) subscribed to the same device with
 * raw `metrics.subscribe`/`unsubscribe`, one closing would unsubscribe the
 * other. Routing every live subscriber through this store coalesces them: a
 * device is subscribed once (on 0→1) and unsubscribed once (on 1→0). It also
 * re-subscribes everything when the socket (re)opens, so live data survives a
 * reconnect.
 */
const refCounts = new Map<string, number>();
let offState: (() => void) | null = null;

function sendSubscribe(deviceId: string): void {
    if (ws.state === 'open') ws.send('metrics.subscribe', { deviceIds: [deviceId] }).catch(() => {});
}

function sendUnsubscribe(deviceId: string): void {
    if (ws.state === 'open') ws.send('metrics.unsubscribe', { deviceIds: [deviceId] }).catch(() => {});
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
    // Envoyé à **chaque** prise, et pas seulement à la première : le serveur
    // répond à `metrics.subscribe` par le dernier instant enregistré, et c'est
    // de là que vient l'affichage « en direct » avant la première poussée. Le
    // compte de références n'existe que pour ne pas désabonner sous les pieds
    // d'un autre consommateur ; s'en servir aussi pour éviter le ré-abonnement
    // privait tout consommateur suivant de cet instant initial — un panneau
    // ouvert alors qu'un autre écran suivait déjà la machine restait sans
    // valeur courante jusqu'à la poussée suivante. Côté serveur l'abonnement
    // est un ensemble : le renvoyer ne coûte que sa réponse.
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
