import { METRICS_PUSH_EVENT, metricsPushSchema, type MetricSeriesPoint } from '@deveye/types';
import { useEffect, useSyncExternalStore } from 'react';

import { ws } from '@/api/ws';
import { acquireMetrics } from './metricsSubscription';

/**
 * Dernière mesure connue de chaque tuile d'appareil de l'accueil.
 *
 * **Abonnement, plus sondage.** Ce store interrogeait le serveur toutes les dix
 * secondes, pour une raison qui a cessé d'être vraie : le hub indexe les
 * abonnements par *socket*, donc deux consommateurs du même appareil se
 * désabonnaient l'un l'autre. `stores/metricsSubscription` a été écrit
 * exactement pour ça — il compte les références et n'émet qu'un abonnement par
 * appareil. Les tuiles peuvent donc partager le flux temps réel de Monitoring
 * au lieu de le doubler d'un sondage.
 *
 * Une seule lecture ponctuelle subsiste, à l'acquisition : un appareil silencieux
 * ne pousserait rien avant sa prochaine télémétrie, et la tuile resterait sur
 * « Mesure en cours » alors que des mesures existent.
 */

/**
 * Fenêtre demandée à l'amorçage ; on n'en garde que le dernier point. Assez
 * large pour qu'une cadence lente (jusqu'à ~10 min) rende quand même un point.
 */
const WINDOW_MS = 15 * 60 * 1000;

const latest = new Map<string, MetricSeriesPoint | null>();
const refCounts = new Map<string, number>();
const releases = new Map<string, () => void>();
const listeners = new Set<() => void>();
let offMessage: (() => void) | null = null;
let offState: (() => void) | null = null;

function emit(): void {
    for (const fn of listeners) fn();
}

/** Amorçage : la dernière mesure déjà en base, en attendant la première poussée. */
async function seed(deviceId: string): Promise<void> {
    if (ws.state !== 'open') return;
    try {
        const now = Date.now();
        const res = await ws.send('metrics.query', {
            deviceId,
            from: now - WINDOW_MS,
            to: now,
            resolution: 'raw'
        });
        // Une fenêtre vide ne doit PAS effacer la dernière valeur connue : la
        // tuile repasserait sur « Mesure en cours » au moindre trou, alors que
        // de vraies mesures existent. Seul un point plus récent remplace.
        if (res.points.length === 0) return;
        const last = res.points[res.points.length - 1];
        // Comparé sur l'horodatage et non sur l'identité de l'objet : `last`
        // sort d'une désérialisation, il n'est jamais celui qu'on a rangé, donc
        // le test précédent était toujours vrai et rendait un rendu à chaque
        // amorçage. Ne remplace que par un point strictement plus récent — une
        // relecture ne doit pas faire reculer une poussée arrivée entre-temps.
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
    if (offMessage) return;
    offMessage = ws.onMessage((msg) => {
        if (msg.command !== METRICS_PUSH_EVENT || !msg.payload.ok) return;
        const push = metricsPushSchema.safeParse(msg.payload.data);
        if (!push.success || !refCounts.has(push.data.deviceId)) return;
        latest.set(push.data.deviceId, push.data.snapshot);
        emit();
    });
    // À la réouverture, `metricsSubscription` réémet les abonnements ; on
    // ré-amorce ici pour ne pas attendre la première télémétrie d'après-coupure.
    offState = ws.onStateChange((s) => {
        if (s === 'open') for (const id of refCounts.keys()) void seed(id);
    });
}

function acquire(deviceId: string): void {
    const next = (refCounts.get(deviceId) ?? 0) + 1;
    refCounts.set(deviceId, next);
    if (next !== 1) return;
    ensureWired();
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
        offMessage?.();
        offMessage = null;
        offState?.();
        offState = null;
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
