import { useSyncExternalStore } from 'react';
import { get } from '@/api/http';
import { serverStatusSchema, type ServerStatus } from 'deveye-types';

/**
 * Server readiness store. Polls `GET /api/status` **only while the server isn't
 * ready** (deployment/boot tasks in flight), then stops for good — no
 * steady-state polling. Powers the discreet topbar deployment zone, which
 * vanishes once `ready` is true.
 */
const POLL_MS = 2500;

let current: ServerStatus | null = null;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let started = false;

function emit(next: ServerStatus): void {
    current = next;
    for (const fn of listeners) fn();
}

function stop(): void {
    if (timer) clearInterval(timer);
    timer = null;
}

async function poll(): Promise<void> {
    try {
        const status = await get('/api/status', serverStatusSchema);
        emit(status);
        if (status.ready) stop(); // settled: never poll again
    } catch {
        // Transient (e.g. server still coming up): keep the timer, retry.
    }
}

function startOnce(): void {
    if (started) return;
    started = true;
    void poll();
    timer = setInterval(() => void poll(), POLL_MS);
}

function subscribe(cb: () => void): () => void {
    listeners.add(cb);
    startOnce();
    return () => {
        listeners.delete(cb);
    };
}

export function useServerStatus(): ServerStatus | null {
    return useSyncExternalStore(
        subscribe,
        () => current,
        () => current
    );
}
