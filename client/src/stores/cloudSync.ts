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

/** Retourne vrai si la vue a RÉELLEMENT changé (donc si un rendu se justifie). */
function applyProgress(p: CloudSyncProgress): boolean {
    const key = `${p.shareId}:${p.deviceId}`;
    if (p.state === 'done' || p.state === 'error' || p.state === 'cancelled') {
        return progressByPair.delete(key); // L'issue est portée par l'état agrégé.
    }
    const previous = progressByPair.get(key);
    progressByPair.set(key, p);
    return previous === undefined || !sameProgress(previous, p);
}

/**
 * Deux progressions équivalentes À L'AFFICHAGE.
 *
 * Le serveur republie à cadence fixe, y compris quand rien n'a bougé (fin de
 * transfert, attente d'un pair, reprise qui piétine). Rendre à l'identique n'a
 * aucun effet visible mais coûte un rendu de toute la vue à chaque tour, ce qui
 * se voyait sous forme de micro-à-coups.
 *
 * On compare donc CHAMP PAR CHAMP plutôt que par référence : c'est la seule
 * façon d'être sûr de ne rien étouffer, un champ nouveau devant être ajouté ici
 * explicitement pour être ignoré.
 *
 * `sessionId` est délibérément hors de la comparaison : il change à chaque
 * tentative, y compris quand la précédente s'est arrêtée sur exactement le même
 * point. Le comparer reviendrait à re-rendre à chaque cycle une vue qui n'a pas
 * bougé d'un pixel — précisément ce qu'on cherche à éviter ici.
 */
function sameProgress(a: CloudSyncProgress, b: CloudSyncProgress): boolean {
    return (
        a.state === b.state &&
        a.direction === b.direction &&
        a.filesDone === b.filesDone &&
        a.filesTotal === b.filesTotal &&
        a.bytesDone === b.bytesDone &&
        a.bytesTotal === b.bytesTotal &&
        a.currentPath === b.currentPath &&
        a.currentBytes === b.currentBytes &&
        a.currentTotal === b.currentTotal &&
        a.error === b.error
    );
}

/** Idem pour l'état agrégé, dont la volumétrie change plus rarement que le rythme de publication. */
function applyState(s: CloudSyncShareState): boolean {
    const previous = stateByShare.get(s.shareId);
    stateByShare.set(s.shareId, s);
    return (
        previous === undefined ||
        previous.state !== s.state ||
        previous.detail !== s.detail ||
        previous.stats.fileCount !== s.stats.fileCount ||
        previous.stats.liveBytes !== s.stats.liveBytes ||
        previous.stats.versionCount !== s.stats.versionCount ||
        previous.stats.versionBytes !== s.stats.versionBytes
    );
}

function sendSubscribe(shareIds: number[]): void {
    if (shareIds.length === 0 || ws.state !== 'open') return;
    void ws
        .send('cloudSync.subscribe', { shareIds })
        .then((out) => {
            let changed = false;
            for (const p of out.progress) changed = applyProgress(p) || changed;
            for (const s of out.states) changed = applyState(s) || changed;
            if (changed) emit();
        })
        .catch(() => {});
}

function ensureWired(): void {
    if (!offMessage) {
        offMessage = ws.onMessage((msg) => {
            if (msg.command === CLOUD_SYNC_PROGRESS_EVENT && msg.payload.ok) {
                if (applyProgress(msg.payload.data as CloudSyncProgress)) emit();
            } else if (msg.command === CLOUD_SYNC_STATE_EVENT && msg.payload.ok) {
                if (applyState(msg.payload.data as CloudSyncShareState)) emit();
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
