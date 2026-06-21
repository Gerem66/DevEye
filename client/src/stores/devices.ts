import { useEffect, useSyncExternalStore } from 'react';
import { ws } from '@/api/ws';
import { markHomeReady } from '@/stores/homeReady';
import type { Device } from 'deveye-types';

/**
 * Shared devices store. Polls `device.list` while any consumer is mounted so the
 * widget, the full Clients view and the topbar status all stay in sync without
 * each re-fetching independently. Poll-based on purpose: the metrics WS
 * subscription is socket-global and owned by Monitoring, so we avoid touching it
 * here to prevent subscribe/unsubscribe conflicts.
 */
const POLL_MS = 6000;

interface DevicesState {
    devices: Device[];
    loading: boolean;
    error: string | null;
}

let state: DevicesState = { devices: [], loading: true, error: null };
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let offState: (() => void) | null = null;
let refCount = 0;

function emit(next: Partial<DevicesState>): void {
    state = { ...state, ...next };
    for (const fn of listeners) fn();
}

export async function refreshDevices(): Promise<void> {
    // The socket may still be connecting (page load) or briefly reconnecting.
    // `ws.send` rejects instantly when it isn't open, so polling then would flash
    // a spurious "Connexion indisponible". Stay in the loading state instead and
    // let the onStateChange handler refresh once the socket opens.
    if (ws.state !== 'open') return;
    try {
        const res = await ws.send('device.list', {});
        emit({ devices: res.devices, loading: false, error: null });
    } catch {
        emit({ loading: false, error: 'Connexion indisponible' });
    }
    // The device list is the dashboard's main above-the-fold content; once it has
    // first settled (loaded or errored) the home is "ready" enough for the login
    // splash to fade onto a populated view. No-op after the first settle.
    markHomeReady();
}

/** Optimistic local removal after `device.delete`; the next poll reconciles. */
export function removeDeviceLocal(id: string): void {
    emit({ devices: state.devices.filter((d) => d.id !== id) });
}

function start(): void {
    refCount += 1;
    if (refCount === 1) {
        void refreshDevices();
        timer = setInterval(() => void refreshDevices(), POLL_MS);
        // Refresh as soon as the socket (re)opens, so the list appears without
        // waiting for the next poll and without an error flash during connect.
        offState = ws.onStateChange((s) => {
            if (s === 'open') void refreshDevices();
        });
    }
}

function stop(): void {
    refCount -= 1;
    if (refCount <= 0) {
        refCount = 0;
        if (timer) {
            clearInterval(timer);
            timer = null;
        }
        if (offState) {
            offState();
            offState = null;
        }
    }
}

function subscribe(cb: () => void): () => void {
    listeners.add(cb);
    return () => listeners.delete(cb);
}

function getSnapshot(): DevicesState {
    return state;
}

export function useDevices(): DevicesState & { refresh: () => Promise<void> } {
    const snap = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    useEffect(() => {
        start();
        return stop;
    }, []);
    return { devices: snap.devices, loading: snap.loading, error: snap.error, refresh: refreshDevices };
}
