import { useEffect, useSyncExternalStore } from 'react';

import { ws } from '@/api/ws';
import { useActiveWorkspace } from './workspace';

/**
 * Shared "services up / total" store, read by the home card and the navbar
 * widget so both show the same number from a single query.
 *
 * Unlike the note/password counters this one changes on its own — the server
 * probes services in the background — so it polls on a timer instead of relying
 * only on the invalidation bus. The Uptime feature calls {@link refreshUptime}
 * after a mutation to reflect it immediately.
 */
const REFRESH_MS = 30_000;

export interface UptimeCountState {
    total: number;
    up: number;
    down: number;
    loading: boolean;
}

let state: UptimeCountState = { total: 0, up: 0, down: 0, loading: true };
const listeners = new Set<() => void>();
let workspaceId: number | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let unsubState: (() => void) | null = null;
let refCount = 0;

function emit(next: Partial<UptimeCountState>): void {
    state = { ...state, ...next };
    for (const fn of listeners) fn();
}

/** Re-read the counts now (after adding, removing or probing a service). */
export async function refreshUptime(): Promise<void> {
    if (workspaceId === null || ws.state !== 'open') return;
    try {
        const res = await ws.send('uptime.count', {});
        emit({ ...res, loading: false });
    } catch {
        // A transient send failure keeps the last good counts rather than
        // collapsing into a misleading "0 / 0".
        if (ws.state === 'open') emit({ loading: false });
    }
}

/** Point the store at a workspace; re-reads whenever it actually changes. */
function setWorkspace(id: number | null): void {
    if (id === workspaceId) return;
    workspaceId = id;
    emit({ loading: true });
    void refreshUptime();
}

function start(): void {
    refCount += 1;
    if (refCount > 1) return;
    void refreshUptime();
    timer = setInterval(() => void refreshUptime(), REFRESH_MS);
    unsubState = ws.onStateChange((s) => {
        if (s === 'open') void refreshUptime();
    });
}

function stop(): void {
    refCount -= 1;
    if (refCount > 0) return;
    refCount = 0;
    if (timer) {
        clearInterval(timer);
        timer = null;
    }
    unsubState?.();
    unsubState = null;
}

function subscribe(cb: () => void): () => void {
    listeners.add(cb);
    return () => listeners.delete(cb);
}

function getSnapshot(): UptimeCountState {
    return state;
}

export function useUptimeCount(): UptimeCountState {
    const workspace = useActiveWorkspace();
    const snap = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

    useEffect(() => {
        setWorkspace(workspace?.id ?? null);
    }, [workspace]);

    useEffect(() => {
        start();
        return stop;
    }, []);

    return snap;
}
