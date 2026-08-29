import { useEffect, useSyncExternalStore } from 'react';
import { isSocketOpen, onResourceChange, onSocketOpen } from 'deveye-sdk-client';
import type { Device } from '@deveye/types';

import { api } from './api';

/**
 * Listes d'appareils partagées, vivantes tant qu'un consommateur est monté. Pas
 * de sondage : la liste se relit quand le sujet `devices` bouge (une commande
 * de flotte, un agent qui se connecte ou se déconnecte). Deux portées, deux
 * listes indépendantes : l'espace actif (accueil, topbar, Monitoring) et la
 * flotte entière (administrateurs), qui ne décrivent pas le même ensemble.
 */
interface DevicesState {
    devices: Device[];
    loading: boolean;
    error: string | null;
}

type Scope = 'workspace' | 'fleet';

interface DeviceListStore {
    refresh: () => Promise<void>;
    reset: () => void;
    use: () => DevicesState & { refresh: () => Promise<void> };
    current: () => Device[];
    onChange: (cb: () => void) => () => void;
}

function createDeviceList(scope: Scope): DeviceListStore {
    let state: DevicesState = { devices: [], loading: true, error: null };
    const listeners = new Set<() => void>();
    let offInvalidate: (() => void) | null = null;
    let offOpen: (() => void) | null = null;
    let refCount = 0;

    function emit(next: Partial<DevicesState>): void {
        state = { ...state, ...next };
        for (const fn of listeners) fn();
    }

    async function refresh(): Promise<void> {
        // Socket pas encore ouverte : un envoi rejetterait aussitôt et ferait
        // clignoter un faux « Connexion indisponible ». La réouverture relance.
        if (!isSocketOpen()) return;
        try {
            const res = await api.send('devices.list', scope === 'fleet' ? { scope } : {});
            emit({ devices: res.devices, loading: false, error: null });
        } catch {
            emit({ loading: false, error: 'Connexion indisponible' });
        }
    }

    function subscribe(cb: () => void): () => void {
        listeners.add(cb);
        return () => listeners.delete(cb);
    }

    function start(): void {
        refCount += 1;
        if (refCount !== 1) return;
        offInvalidate = onResourceChange('devices.list', () => void refresh());
        // Tout de suite si la socket est ouverte, puis à chaque réouverture.
        offOpen = onSocketOpen(() => void refresh());
    }

    function stop(): void {
        refCount -= 1;
        if (refCount > 0) return;
        refCount = 0;
        offInvalidate?.();
        offInvalidate = null;
        offOpen?.();
        offOpen = null;
    }

    return {
        refresh,
        reset: () => emit({ devices: [], loading: true, error: null }),
        use: () => {
            const snap = useSyncExternalStore(
                subscribe,
                () => state,
                () => state
            );
            useEffect(() => {
                start();
                return stop;
            }, []);
            return { devices: snap.devices, loading: snap.loading, error: snap.error, refresh };
        },
        current: () => state.devices,
        onChange: subscribe
    };
}

/** Les appareils de l'espace actif : accueil, topbar, Monitoring. */
const workspaceList = createDeviceList('workspace');

/** Toute la flotte : segment « Flotte », administrateurs uniquement. */
const fleetList = createDeviceList('fleet');

export const refreshDevices = workspaceList.refresh;
export const useDevices = workspaceList.use;
export const currentDevices = workspaceList.current;
export const onDevicesChange = workspaceList.onChange;

export const useFleetDevices = fleetList.use;

/**
 * Vide les deux listes et repasse en chargement, à la déconnexion et à chaque
 * bascule d'espace. Sans ça, le nouvel espace démarre avec les appareils du
 * précédent et `loading: false` : l'accueil élague ses tuiles contre une liste
 * étrangère et les supprime définitivement.
 */
export function resetDevices(): void {
    workspaceList.reset();
    fleetList.reset();
}
