import { useEffect, useSyncExternalStore } from 'react';
import { isSocketOpen, onResourceChange, onSocketOpen, useActiveWorkspace } from 'deveye-sdk-client';

import type { SeverityCounts } from '../contracts/domain';

import { api } from './api';

/**
 * Le décompte partagé par la carte de l'accueil et la pastille de Monitoring.
 * Pas de sondage : le sujet `sentinel` ravive `sentinel.count` ; la feature
 * appelle {@link refreshSentinel} après ses propres mutations.
 */

export interface SentinelCountState {
    open: SeverityCounts;
    /** Appareils sur lesquels Sentinelle est active. */
    watched: number;
    loading: boolean;
}

const EMPTY: SeverityCounts = { info: 0, low: 0, high: 0, critical: 0 };

let state: SentinelCountState = { open: EMPTY, watched: 0, loading: true };
const listeners = new Set<() => void>();
let workspaceId: number | null = null;
let unsubState: (() => void) | null = null;
let unsubInvalidate: (() => void) | null = null;
let refCount = 0;

function emit(next: Partial<SentinelCountState>): void {
    state = { ...state, ...next };
    for (const fn of listeners) fn();
}

/** Relit le décompte maintenant (après un acquittement, un réglage). */
export async function refreshSentinel(): Promise<void> {
    if (workspaceId === null || !isSocketOpen()) return;
    try {
        const res = await api.send('sentinel.count', {});
        emit({ open: res.open, watched: res.watched, loading: false });
    } catch {
        // Un envoi qui échoue garde le dernier décompte connu plutôt que de
        // retomber sur un « 0 constat » qui se lirait comme une bonne nouvelle.
        if (isSocketOpen()) emit({ loading: false });
    }
}

function setWorkspace(id: number | null): void {
    if (id === workspaceId) return;
    workspaceId = id;
    emit({ loading: true });
    void refreshSentinel();
}

function start(): void {
    refCount += 1;
    if (refCount > 1) return;
    void refreshSentinel();
    unsubInvalidate = onResourceChange('sentinel.count', () => void refreshSentinel());
    // Reload as soon as the socket (re)connects (fires now if already open).
    unsubState = onSocketOpen(() => void refreshSentinel());
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

function getSnapshot(): SentinelCountState {
    return state;
}

export function useSentinelCount(): SentinelCountState {
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

/** Le total, toutes gravités confondues. */
export function totalOpen(counts: SeverityCounts): number {
    return counts.info + counts.low + counts.high + counts.critical;
}

/** La pire gravité présente, ou `null` : ce qu'on lit d'un coup d'œil est « à quel point ». */
export function worstSeverity(counts: SeverityCounts): keyof SeverityCounts | null {
    if (counts.critical > 0) return 'critical';
    if (counts.high > 0) return 'high';
    if (counts.low > 0) return 'low';
    if (counts.info > 0) return 'info';
    return null;
}
