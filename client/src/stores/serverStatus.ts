import { useSyncExternalStore } from 'react';
import { get } from '@/api/http';
import { serverStatusSchema, type ServerStatus } from 'deveye-types';

/**
 * Server readiness store. Polls `GET /api/status` **only while a boot task is
 * still in flight**, and stops for good once everything has **settled** (every
 * task `done` or `error`) — no steady-state polling, and no infinite polling
 * after a terminal error. Powers the discreet topbar deployment zone, which
 * stays visible while not `ready` (so an error remains on screen) but no longer
 * triggers requests.
 */
const POLL_MS = 10_000;

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
        // Settled = every task reached a terminal state. Stop polling for good
        // (a done set hides the zone; a terminal error stays shown, frozen).
        const settled = status.tasks.every((t) => t.state === 'done' || t.state === 'error');
        if (settled) stop();
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
