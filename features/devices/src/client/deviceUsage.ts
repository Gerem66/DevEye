import { METRICS_PUSH_EVENT, metricsPushSchema, type MetricSeriesPoint } from '@deveye/types';
import { useEffect, useSyncExternalStore } from 'react';
import { acquireMetrics, isSocketOpen, onServerEvent, onSocketOpen } from 'deveye-sdk-client';

import { api } from './api';

/**
 * Dernière mesure connue de chaque tuile d'appareil de l'accueil, par
 * abonnement partagé (`acquireMetrics` compte les références : un seul
 * abonnement par appareil). Une seule lecture ponctuelle à l'acquisition : un
 * appareil silencieux ne pousserait rien avant sa prochaine télémétrie.
 */

/** Fenêtre demandée à l'amorçage (on garde le dernier point) : couvre une cadence lente. */
const WINDOW_MS = 15 * 60 * 1000;

const latest = new Map<string, MetricSeriesPoint | null>();
const refCounts = new Map<string, number>();
const releases = new Map<string, () => void>();
const listeners = new Set<() => void>();
let offPush: (() => void) | null = null;
let offOpen: (() => void) | null = null;

function emit(): void {
    for (const fn of listeners) fn();
}

/** Amorçage : la dernière mesure déjà en base, en attendant la première poussée. */
async function seed(deviceId: string): Promise<void> {
    if (!isSocketOpen()) return;
    try {
        const now = Date.now();
        const res = await api.send('devices.metrics', {
            deviceId,
            from: now - WINDOW_MS,
            to: now,
            resolution: 'raw'
        });
        // Une fenêtre vide ne doit PAS effacer la dernière valeur connue : la
        // tuile repasserait sur « Mesure en cours » au moindre trou.
        if (res.points.length === 0) return;
        const last = res.points[res.points.length - 1];
        // Ne remplace que par un point strictement plus récent : une relecture
        // ne doit pas faire reculer une poussée arrivée entre-temps.
        const known = latest.get(deviceId);
        if (!known || last.timestamp > known.timestamp) {
            latest.set(deviceId, last);
            emit();
        }
    } catch {
        /* Panne passagère : on garde la dernière bonne valeur. */
    }
}

function ensureWired(): void {
    if (offPush) return;
    offPush = onServerEvent(METRICS_PUSH_EVENT, metricsPushSchema, (push) => {
        if (!refCounts.has(push.deviceId)) return;
        latest.set(push.deviceId, push.snapshot);
        emit();
    });
    // À la réouverture, on ré-amorce pour ne pas attendre la première télémétrie
    // d'après-coupure. Branché AVANT la première référence : le rappel part
    // aussi tout de suite quand la socket est déjà ouverte.
    offOpen = onSocketOpen(() => {
        for (const id of refCounts.keys()) void seed(id);
    });
}

function acquire(deviceId: string): void {
    const next = (refCounts.get(deviceId) ?? 0) + 1;
    if (next !== 1) {
        refCounts.set(deviceId, next);
        return;
    }
    ensureWired();
    refCounts.set(deviceId, next);
    releases.set(deviceId, acquireMetrics(deviceId));
    void seed(deviceId);
}

function release(deviceId: string): void {
    const next = (refCounts.get(deviceId) ?? 1) - 1;
    if (next > 0) {
        refCounts.set(deviceId, next);
        return;
    }
    refCounts.delete(deviceId);
    releases.get(deviceId)?.();
    releases.delete(deviceId);
    latest.delete(deviceId);
    if (refCounts.size === 0) {
        offPush?.();
        offPush = null;
        offOpen?.();
        offOpen = null;
    }
}

function subscribe(cb: () => void): () => void {
    listeners.add(cb);
    return () => listeners.delete(cb);
}

/** Dernière mesure connue d'une tuile (null tant que rien n'est arrivé). */
export function useDeviceUsage(deviceId: string): MetricSeriesPoint | null {
    const snap = useSyncExternalStore(
        subscribe,
        () => latest.get(deviceId) ?? null,
        () => null
    );
    useEffect(() => {
        acquire(deviceId);
        return () => release(deviceId);
    }, [deviceId]);
    return snap;
}
