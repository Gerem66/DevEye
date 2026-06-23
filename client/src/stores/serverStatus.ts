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
 *
 * The cadence is adaptive: a light **10s** beat while the server is building or
 * waiting (no live numbers to show), tightening to **1s** as soon as a download
 * is streaming (a `running` task with numeric `progress`) so the topbar bar
 * advances in near real time. Self-rescheduling via `setTimeout` (not a fixed
 * `setInterval`) makes that switch trivial and avoids overlapping requests.
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
        const status = await get('/api/status', serverStatusSchema);
        emit(status);
        // Settled = every task reached a terminal state. Stop polling for good
        // (a done set hides the zone; a terminal error stays shown, frozen).
        const settled = status.tasks.every((t) => t.state === 'done' || t.state === 'error');
        if (settled) {
            stop();
            return;
        }
    } catch {
        // Transient (e.g. server still coming up): keep polling, retry.
    }
    // Reschedule on the cadence the *current* state warrants: fast while a
    // download streams, slow otherwise.
    timer = setTimeout(() => void poll(), isDownloading(current) ? FAST_MS : SLOW_MS);
}

function startOnce(): void {
    if (started) return;
    started = true;
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
