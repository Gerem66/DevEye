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
    if (next === 1) {
        ensureStateSub();
        sendSubscribe(deviceId);
    }

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
