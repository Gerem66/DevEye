import { useSyncExternalStore } from 'react';

import { agent } from './api';
import { currentDevices, onDevicesChange, refreshDevices } from './store';

/**
 * Shared, socket-global state for agent self-updates in flight. One source of
 * truth so **every** surface that shows an update affordance for a device (the
 * Monitoring sidebar, the Monitoring panel header and the fleet card) spins
 * together and stays spinning for the *whole* process, not just while the order is
 * being sent.
 *
 * An update is "in flight" from the moment its order is sent until the agent has
 * actually swapped its binary and reconnected. We detect that completion from the
 * device list the {@link import('./store')} store keeps live: the agent reports
 * its version on reconnect (`agent.hello`), so when the reported `agentVersion`
 * changes from the value captured at trigger time (or the server stops
 * advertising an update for it) the swap is done and the spinner clears.
 *
 * A safety timeout caps the spinner so an update that never completes (agent
 * offline mid-swap, signed binary missing, …) can't pin it forever; the failure is
 * also surfaced by the caller when the *order* itself is refused.
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

/**
 * Reconcile in-flight updates against the latest device list: an update completes
 * once the agent reconnects with a different version (or the server no longer
 * advertises one for it).
 */
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
 * Start (and track) an agent self-update for one device. Resolves once the order is
 * accepted by the server; rejects with the server's reason if it's refused, after
 * clearing the in-flight state so the spinner doesn't hang. The spinner then stays
 * up until {@link reconcile} sees the agent reconnect on the newer version.
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
        // Pull the list promptly so completion is detected without waiting the topic.
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

/**
 * Reactive view of in-flight agent updates. Consumers re-render whenever any
 * update starts or completes, so their spinners stay in lock-step.
 */
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
