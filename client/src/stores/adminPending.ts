import { useMemo, useSyncExternalStore } from 'react';
import { canModerate, type AdminPending } from '@deveye/types';

import { ws, WsError } from '@/api/ws';
import { moduleManifest } from '@/sdk/registry';
import { getCurrentUser, onCurrentUserChange } from './currentUser';
import { onResourceChange } from './invalidation';

/**
 * Ce qui attend un modérateur ou un administrateur, partagé par le menu du
 * compte et la popup d'administration : une seule lecture pour tous les
 * badges. Relu au sujet `pending`, à chaque (re)connexion de la socket active
 * et quand le compte courant change de rôle ou d'instance.
 */
const NONE: AdminPending = { feedback: 0, features: {} };

let snapshot: AdminPending = NONE;
/** Le compte et le rôle de la dernière lecture : seul un changement de l'un d'eux relit. */
let readFor: string | null = null;
/** Une réponse plus ancienne que la dernière demande est jetée. */
let request = 0;
const listeners = new Set<() => void>();
let unwire: (() => void) | null = null;

function publish(next: AdminPending): void {
    if (next === snapshot) return;
    snapshot = next;
    for (const fn of listeners) fn();
}

function identity(): string | null {
    const user = getCurrentUser();
    return user && canModerate(user.role) ? `${user.id}:${user.role}` : null;
}

function refetch(): void {
    const id = ++request;
    if (identity() === null) {
        publish(NONE);
        return;
    }
    if (ws.state !== 'open') return;
    ws.send('admin.pending', {}).then(
        (next) => {
            if (id === request) publish(next);
        },
        (e: unknown) => {
            // Rôle retiré avant que la session ne le dise : plus rien à montrer.
            // Une coupure, elle, garde les derniers chiffres jusqu'à la reconnexion.
            if (id === request && e instanceof WsError && e.code === 'forbidden') publish(NONE);
        }
    );
}

function wire(): () => void {
    readFor = identity();
    const offKey = onResourceChange('admin.pending', refetch);
    const offState = ws.onStateChange((state) => {
        if (state === 'open') refetch();
    });
    const offUser = onCurrentUserChange(() => {
        const next = identity();
        if (next === readFor) return;
        readFor = next;
        refetch();
    });
    refetch();
    return () => {
        offKey();
        offState();
        offUser();
    };
}

function subscribe(fn: () => void): () => void {
    listeners.add(fn);
    unwire ??= wire();
    return () => {
        listeners.delete(fn);
        if (listeners.size > 0) return;
        unwire?.();
        unwire = null;
    };
}

const getSnapshot = (): AdminPending => snapshot;

export interface AdminPendingCounts {
    /** Les retours non lus. */
    feedback: number;
    /** Tout ce qui attend dans la popup d'administration des fonctionnalités. */
    features: number;
    /** Ce qui attend dans une fonctionnalité, tous ses onglets confondus. */
    featureTotal(featureId: string): number;
    tabCount(featureId: string, tabId: string): number;
}

/**
 * Seuls comptent les onglets que le module déclare : un badge mène toujours à
 * quelque chose qu'on peut ouvrir.
 */
function countsOf(state: AdminPending): AdminPendingCounts {
    const tabs = new Map<string, Readonly<Record<string, number>>>();
    const totals = new Map<string, number>();
    let features = 0;
    for (const [featureId, counts] of Object.entries(state.features)) {
        const declared = moduleManifest(featureId)?.adminTabs ?? [];
        const kept: Record<string, number> = {};
        let total = 0;
        for (const tab of declared) {
            const count = counts[tab.id] ?? 0;
            if (count <= 0) continue;
            kept[tab.id] = count;
            total += count;
        }
        if (total === 0) continue;
        tabs.set(featureId, kept);
        totals.set(featureId, total);
        features += total;
    }
    return {
        feedback: state.feedback,
        features,
        featureTotal: (featureId) => totals.get(featureId) ?? 0,
        tabCount: (featureId, tabId) => tabs.get(featureId)?.[tabId] ?? 0
    };
}

/** Tout à zéro pour un compte qui ne modère pas : rien n'est alors demandé au serveur. */
export function useAdminPending(): AdminPendingCounts {
    const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    return useMemo(() => countsOf(state), [state]);
}
