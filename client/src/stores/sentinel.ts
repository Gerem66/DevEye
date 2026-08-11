import { useEffect, useSyncExternalStore } from 'react';
import type { SeverityCounts } from 'deveye-types';

import { ws } from '@/api/ws';
import { onResourceChange } from './invalidation';
import { useActiveWorkspace } from './workspace';

/**
 * Le décompte de constats ouverts, partagé par la carte de l'accueil et la
 * pastille de Monitoring — une seule requête pour deux affichages.
 *
 * Comme celui d'Uptime, il ne sonde pas : le moteur diffuse `live.changed` sur
 * le sujet `sentinel` à chaque constat ouvert, et c'est ce qui déclenche la
 * relecture. La feature appelle {@link refreshSentinel} après ses propres
 * mutations, dont le serveur ne lui renvoie pas l'écho.
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
    if (workspaceId === null || ws.state !== 'open') return;
    try {
        const res = await ws.send('sentinel.count', {});
        emit({ open: res.open, watched: res.watched, loading: false });
    } catch {
        // Un envoi qui échoue garde le dernier décompte connu plutôt que de
        // retomber sur un « 0 constat » qui se lirait comme une bonne nouvelle.
        if (ws.state === 'open') emit({ loading: false });
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
    unsubState = ws.onStateChange((s) => {
        if (s === 'open') void refreshSentinel();
    });
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

/**
 * La pire gravité présente, ou `null` si rien n'est ouvert.
 *
 * Sert à teinter la carte : ce qu'on veut lire d'un coup d'œil n'est pas
 * « combien » mais « à quel point ».
 */
export function worstSeverity(counts: SeverityCounts): keyof SeverityCounts | null {
    if (counts.critical > 0) return 'critical';
    if (counts.high > 0) return 'high';
    if (counts.low > 0) return 'low';
    if (counts.info > 0) return 'info';
    return null;
}
