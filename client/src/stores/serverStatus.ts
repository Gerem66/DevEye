import { useSyncExternalStore } from 'react';
import { getLocal } from '@/api/http';
import { serverStatusSchema, type ServerStatus } from '@deveye/types';

/**
 * Server readiness store. Polls `GET /api/status` only while a boot task is still
 * in flight, and stops for good once every task has settled. The cadence adapts to
 * what is happening, and a self-rescheduling `setTimeout` rather than
 * `setInterval` keeps requests from overlapping.
 */
const SLOW_MS = 10_000; // building / waiting: nothing live to watch yet
const FAST_MS = 1_000; // a download is streaming: show it advance

let current: ServerStatus | null = null;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | null = null;
let started = false;

function emit(next: ServerStatus): void {
    current = next;
    for (const fn of listeners) fn();
}

function stop(): void {
    if (timer) clearTimeout(timer);
    timer = null;
}

/** A download has started once a running task exposes numeric progress. */
function isDownloading(status: ServerStatus | null): boolean {
    return status !== null && status.tasks.some((t) => t.state === 'running' && t.progress !== null);
}

async function poll(): Promise<void> {
    try {
        const status = await getLocal('/api/status', serverStatusSchema);
        emit(status);
        // Settled = every task reached a terminal state: stop polling for good.
        const settled = status.tasks.every((t) => t.state === 'done' || t.state === 'warning' || t.state === 'error');
        if (settled) {
            stop();
            return;
        }
    } catch {
        // Transient (e.g. server still coming up): keep polling, retry.
    }
    // Reschedule on the cadence the current state warrants.
    timer = setTimeout(() => void poll(), isDownloading(current) ? FAST_MS : SLOW_MS);
}

function startOnce(): void {
    if (started) return;
    started = true;
    // In the Vite dev server the agents aren't built, so the boot status never
    // settles: skip the polling entirely.
    if (import.meta.env.DEV) return;
    void poll();
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
