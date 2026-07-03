import { useSyncExternalStore } from 'react';
import {
    CLOUD_SYNC_PROGRESS_EVENT,
    CLOUD_SYNC_STATE_EVENT,
    type CloudSyncProgress,
    type CloudSyncShareState
} from 'deveye-types';
import { ws } from '@/api/ws';

/**
 * Abonnement live CloudSync, ref-compté par partage (même logique que
 * `metricsSubscription`) : le widget de la grille et la vue pleine peuvent
 * regarder les mêmes partages sans se désabonner mutuellement, et tout est
 * réabonné à la reconnexion du socket (l'instantané re-seed l'état).
 */

const refCounts = new Map<number, number>();
/** `shareId:deviceId` → progression de la session active. */
const progressByPair = new Map<string, CloudSyncProgress>();
const stateByShare = new Map<number, CloudSyncShareState>();
const listeners = new Set<() => void>();
let revision = 0;
let offMessage: (() => void) | null = null;
let offState: (() => void) | null = null;

function emit(): void {
    revision += 1;
    for (const fn of listeners) fn();
}

function applyProgress(p: CloudSyncProgress): void {
    const key = `${p.shareId}:${p.deviceId}`;
    if (p.state === 'done' || p.state === 'error' || p.state === 'cancelled') {
        progressByPair.delete(key); // L'issue est portée par l'état agrégé.
    } else {
        progressByPair.set(key, p);
    }
}

function sendSubscribe(shareIds: number[]): void {
    if (shareIds.length === 0 || ws.state !== 'open') return;
    void ws
        .send('cloudSync.subscribe', { shareIds })
        .then((out) => {
            for (const p of out.progress) applyProgress(p);
            for (const s of out.states) stateByShare.set(s.shareId, s);
            emit();
        })
        .catch(() => {});
}

function ensureWired(): void {
    if (!offMessage) {
        offMessage = ws.onMessage((msg) => {
            if (msg.command === CLOUD_SYNC_PROGRESS_EVENT && msg.payload.ok) {
                applyProgress(msg.payload.data as CloudSyncProgress);
                emit();
            } else if (msg.command === CLOUD_SYNC_STATE_EVENT && msg.payload.ok) {
                const s = msg.payload.data as CloudSyncShareState;
                stateByShare.set(s.shareId, s);
                emit();
            }
        });
    }
    if (!offState) {
        offState = ws.onStateChange((s) => {
            if (s === 'open') sendSubscribe([...refCounts.keys()]);
        });
    }
}

function teardownIfIdle(): void {
    if (refCounts.size > 0) return;
    offMessage?.();
    offMessage = null;
    offState?.();
    offState = null;
    progressByPair.clear();
    stateByShare.clear();
}

/**
 * Acquiert l'abonnement live aux partages donnés. Retourne la fonction de
 * libération (à appeler une fois, depuis un cleanup d'effet).
 */
export function acquireCloudSync(shareIds: number[]): () => void {
    const fresh: number[] = [];
    for (const id of shareIds) {
        const next = (refCounts.get(id) ?? 0) + 1;
        refCounts.set(id, next);
        if (next === 1) fresh.push(id);
    }
    ensureWired();
    sendSubscribe(fresh);

    let released = false;
    return () => {
        if (released) return;
        released = true;
        const gone: number[] = [];
        for (const id of shareIds) {
            const count = (refCounts.get(id) ?? 1) - 1;
            if (count <= 0) {
                refCounts.delete(id);
                gone.push(id);
            } else {
                refCounts.set(id, count);
            }
        }
        if (gone.length > 0 && ws.state === 'open') {
            void ws.send('cloudSync.unsubscribe', { shareIds: gone }).catch(() => {});
            for (const id of gone) {
                stateByShare.delete(id);
                for (const key of progressByPair.keys()) {
                    if (key.startsWith(`${id}:`)) progressByPair.delete(key);
                }
            }
        }
        teardownIfIdle();
        emit();
    };
}

function subscribe(cb: () => void): () => void {
    listeners.add(cb);
    return () => listeners.delete(cb);
}

function getSnapshot(): number {
    return revision;
}

/** Vue réactive de l'état live : progression par partage + état agrégé. */
export function useCloudSyncLive(): {
    stateFor: (shareId: number) => CloudSyncShareState | undefined;
    progressFor: (shareId: number) => CloudSyncProgress[];
} {
    useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    return {
        stateFor: (shareId) => stateByShare.get(shareId),
        progressFor: (shareId) => [...progressByPair.values()].filter((p) => p.shareId === shareId)
    };
}
