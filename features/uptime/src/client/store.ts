import { useEffect, useSyncExternalStore } from 'react';
import { isSocketOpen, onResourceChange, onSocketOpen, useActiveWorkspace } from 'deveye-sdk-client';

import { api } from './api';

/**
 * Shared "services up / total" store, read by the home card and the topbar
 * widget so both show the same number from a single query.
 *
 * Pas de sondage : le service de fond diffuse `live.changed` à chaque transition
 * d'état, ce qui ravive `uptime.count`. La vue Uptime appelle {@link refreshUptime}
 * après ses propres mutations, dont le serveur ne lui renvoie pas l'écho.
 */

export interface UptimeCountState {
    total: number;
    up: number;
    down: number;
    loading: boolean;
}

let state: UptimeCountState = { total: 0, up: 0, down: 0, loading: true };
const listeners = new Set<() => void>();
let workspaceId: number | null = null;
let unsubState: (() => void) | null = null;
let unsubInvalidate: (() => void) | null = null;
let refCount = 0;

function emit(next: Partial<UptimeCountState>): void {
    state = { ...state, ...next };
    for (const fn of listeners) fn();
}

/** Re-read the counts now (after adding, removing or probing a service). */
export async function refreshUptime(): Promise<void> {
    if (workspaceId === null || !isSocketOpen()) return;
    try {
        const res = await api.send('uptime.count', {});
        emit({ ...res, loading: false });
    } catch {
        // A transient send failure keeps the last good counts rather than
        // collapsing into a misleading "0 / 0".
        if (isSocketOpen()) emit({ loading: false });
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
    unsubInvalidate = onResourceChange('uptime.count', () => void refreshUptime());
    // Reload as soon as the socket (re)connects (fires now if already open).
    unsubState = onSocketOpen(() => void refreshUptime());
}

function stop(): void {
    refCount -= 1;
    if (refCount > 0) return;
    refCount = 0;
    unsubInvalidate?.();
    unsubInvalidate = null;
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
