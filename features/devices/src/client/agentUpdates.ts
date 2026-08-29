import { useSyncExternalStore } from 'react';

import { agent } from './api';
import { currentDevices, onDevicesChange, refreshDevices } from './store';

/**
 * Socket-global state for agent self-updates in flight, so every surface with an
 * update affordance spins together for the whole process. An update is in flight
 * from the order until the agent reconnects with another `agentVersion` (or the
 * server stops advertising one); a safety timeout caps the spinner.
 */

/** Max time a spinner stays up without an observed completion, as a fallback. */
const TIMEOUT_MS = 120_000;

interface InFlight {
    /** Reported agent version at trigger time; completion is detected as a change. */
    baselineVersion: string | null;
    /** Safety timer that force-clears the entry if no completion is observed. */
    timer: ReturnType<typeof setTimeout>;
}

const inFlight = new Map<string, InFlight>();
const listeners = new Set<() => void>();
/** Bumped on every change so `useSyncExternalStore` re-renders consumers. */
let revision = 0;
/** Unsubscribe from the device store, held only while something is in flight. */
let offDevices: (() => void) | null = null;

function emit(): void {
    revision += 1;
    for (const fn of listeners) fn();
}

function clear(deviceId: string): void {
    const entry = inFlight.get(deviceId);
    if (!entry) return;
    clearTimeout(entry.timer);
    inFlight.delete(deviceId);
    if (inFlight.size === 0 && offDevices) {
        offDevices();
        offDevices = null;
    }
    emit();
}

/** An update completes once the agent reconnects with a different version (or none is advertised). */
function reconcile(): void {
    if (inFlight.size === 0) return;
    const devices = currentDevices();
    for (const [id, entry] of inFlight) {
        const device = devices.find((d) => d.id === id);
        if (!device) continue;
        const versionChanged = device.agentVersion !== entry.baselineVersion;
        if (versionChanged || !device.agentUpdateAvailable) clear(id);
    }
}

/**
 * Start (and track) an agent self-update for one device. Resolves once the order
 * is accepted; rejects with the server's reason if refused, clearing the
 * in-flight state so the spinner doesn't hang.
 */
export async function startAgentUpdate(deviceId: string): Promise<void> {
    if (inFlight.has(deviceId)) return;
    const baselineVersion = currentDevices().find((d) => d.id === deviceId)?.agentVersion ?? null;
    const timer = setTimeout(() => clear(deviceId), TIMEOUT_MS);
    inFlight.set(deviceId, { baselineVersion, timer });
    if (!offDevices) offDevices = onDevicesChange(reconcile);
    emit();

    try {
        await agent.send('agent.update', { deviceId });
        // Completion is detected without waiting for the topic.
        void refreshDevices();
    } catch (e) {
        clear(deviceId);
        throw e;
    }
}

function subscribe(cb: () => void): () => void {
    listeners.add(cb);
    return () => listeners.delete(cb);
}

function getSnapshot(): number {
    return revision;
}

/** Reactive view of in-flight agent updates: consumers re-render on every start or completion. */
export function useAgentUpdates(): {
    isUpdating: (deviceId: string) => boolean;
    anyUpdating: boolean;
} {
    useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    return {
        isUpdating: (deviceId: string) => inFlight.has(deviceId),
        anyUpdating: inFlight.size > 0
    };
}
