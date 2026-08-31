import { useEffect, useSyncExternalStore } from 'react';
import { isSocketOpen, onResourceChange, onSocketOpen, useActiveWorkspace } from 'deveye-sdk-client';

import type { CveEntry } from '../contracts/domain';
import { api } from './api';
import { cveError, type CveError } from './errors';

/**
 * Le fil partagé : la carte de l'accueil et l'onglet « Actualités » lisent le
 * même relevé, d'une seule requête.
 *
 * Pas de sondage : le service d'ingestion bat `cveFeed` quand des CVE ont
 * bougé, ce qui ravive `cve.news`.
 */

/** Ce que la carte affiche, et ce que le fil charge d'un coup. */
export const NEWS_LIMIT = 60;

export interface CveNewsState {
    entries: readonly CveEntry[];
    /** Dernier tour d'ingestion réussi, `null` tant qu'il n'y en a pas eu. */
    ingestedAt: number | null;
    loading: boolean;
    error: CveError | null;
}

let state: CveNewsState = { entries: [], ingestedAt: null, loading: true, error: null };
const listeners = new Set<() => void>();
let workspaceId: number | null = null;
let unsubState: (() => void) | null = null;
let unsubInvalidate: (() => void) | null = null;
let refCount = 0;

function emit(next: Partial<CveNewsState>): void {
    state = { ...state, ...next };
    for (const fn of listeners) fn();
}

/** Relit le fil maintenant (après une épingle, ou à la demande de la vue). */
export async function refreshCveNews(): Promise<void> {
    if (workspaceId === null || !isSocketOpen()) return;
    try {
        const res = await api.send('cve.news', { severity: 'all', limit: NEWS_LIMIT });
        emit({ entries: res.entries, ingestedAt: res.ingestedAt, loading: false, error: null });
    } catch (e) {
        // Un échec passager garde le dernier fil connu plutôt que de le vider.
        if (isSocketOpen()) emit({ loading: false, error: cveError(e, 'Le fil n’a pas pu être chargé.') });
    }
}

function setWorkspace(id: number | null): void {
    if (id === workspaceId) return;
    workspaceId = id;
    emit({ entries: [], loading: true, error: null });
    void refreshCveNews();
}

function start(): void {
    refCount += 1;
    if (refCount > 1) return;
    void refreshCveNews();
    unsubInvalidate = onResourceChange('cve.news', () => void refreshCveNews());
    unsubState = onSocketOpen(() => void refreshCveNews());
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

function getSnapshot(): CveNewsState {
    return state;
}

export function useCveNews(): CveNewsState {
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
