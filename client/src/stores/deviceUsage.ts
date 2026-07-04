import { useEffect, useSyncExternalStore } from 'react';
import { ws } from '@/api/ws';
import type { MetricSnapshot } from 'deveye-types';

/**
 * Latest-usage store for device tiles on the home grid. Each mounted tile
 * acquires its device id; while at least one consumer watches a device we poll
 * its most recent metric point and keep it here.
 *
 * Poll-based on purpose — NOT `metrics.subscribe`. The server hub indexes live
 * subscriptions by *socket* (see `src/agent/hub.ts`): on the single client
 * socket, two consumers subscribing to the same device would unsubscribe each
 * other. Monitoring (the full view / the device popup) keeps that live
 * subscription; the lightweight tiles only need a "current value" every few
 * seconds, so polling stays fully decoupled and conflict-free.
 */
const POLL_MS = 10_000;
/**
 * Window we ask for; we only keep the last point (≈ current value). Wide enough
 * that even a slow snapshot cadence (up to ~10 min) still yields a point, so the
 * tile populates instead of showing "Mesure en cours" forever.
 */
const WINDOW_MS = 15 * 60 * 1000;

const latest = new Map<string, MetricSnapshot | null>();
const refCounts = new Map<string, number>();
const timers = new Map<string, ReturnType<typeof setInterval>>();
const listeners = new Set<() => void>();
let offState: (() => void) | null = null;

function emit(): void {
    for (const fn of listeners) fn();
}

async function poll(deviceId: string): Promise<void> {
    if (ws.state !== 'open') return;
    try {
        const now = Date.now();
        const res = await ws.send('metrics.query', {
            deviceId,
            from: now - WINDOW_MS,
            to: now,
            resolution: 'raw'
        });
        // A poll that finds no point in the window must NOT wipe the last known
        // usage: doing so made the tile flip back to "Mesure en cours" on any
        // transient gap even though real measurements exist. Keep the last value
        // (the tile only shows it while the device is online); only a newer point
        // replaces it. First load with genuinely no data stays null (correct).
        if (res.points.length === 0) return;
        const last = res.points[res.points.length - 1];
        if (last !== latest.get(deviceId)) {
            latest.set(deviceId, last);
            emit();
        }
    } catch {
        // Keep the last good value on a transient failure (socket blip).
    }
}

function ensureStateSub(): void {
    if (offState) return;
    // Repoll every watched device as soon as the socket (re)opens.
    offState = ws.onStateChange((s) => {
        if (s === 'open') for (const id of refCounts.keys()) void poll(id);
    });
}

function acquire(deviceId: string): void {
    const next = (refCounts.get(deviceId) ?? 0) + 1;
    refCounts.set(deviceId, next);
    if (next === 1) {
        ensureStateSub();
        void poll(deviceId);
        timers.set(
            deviceId,
            setInterval(() => void poll(deviceId), POLL_MS)
        );
    }
}

function release(deviceId: string): void {
    const next = (refCounts.get(deviceId) ?? 1) - 1;
    if (next <= 0) {
        refCounts.delete(deviceId);
        const timer = timers.get(deviceId);
        if (timer) clearInterval(timer);
        timers.delete(deviceId);
        latest.delete(deviceId);
        if (refCounts.size === 0 && offState) {
            offState();
            offState = null;
        }
    } else {
        refCounts.set(deviceId, next);
    }
}

function subscribe(cb: () => void): () => void {
    listeners.add(cb);
    return () => listeners.delete(cb);
}

/** Latest known usage snapshot for a device tile (null until first poll lands). */
export function useDeviceUsage(deviceId: string): MetricSnapshot | null {
    const snap = useSyncExternalStore(
        subscribe,
        () => latest.get(deviceId) ?? null,
        () => null
    );
    useEffect(() => {
        acquire(deviceId);
        return () => release(deviceId);
    }, [deviceId]);
    return snap;
}
