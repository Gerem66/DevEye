import { useEffect, useSyncExternalStore } from 'react';
import { isSocketOpen, onResourceChange, onSocketOpen } from 'deveye-sdk-client';

import type { FleetDevice } from '../contracts/commands';
import { api } from './api';

/**
 * La liste des appareils de l'espace actif, partagée et vivante tant qu'un
 * consommateur est monté. Pas de sondage : elle se relit quand le sujet
 * `devices` bouge (une écriture de flotte, un agent qui se connecte ou se
 * déconnecte).
 */
interface DevicesState {
    devices: FleetDevice[];
    loading: boolean;
    error: string | null;
}

interface DeviceListStore {
    refresh: () => Promise<void>;
    reset: () => void;
    use: () => DevicesState & { refresh: () => Promise<void> };
    current: () => FleetDevice[];
    onChange: (cb: () => void) => () => void;
}

function createDeviceList(): DeviceListStore {
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
            const res = await api.send('devices.list', {});
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

/** Les appareils de l'espace actif : accueil, topbar, vue Appareils. */
const workspaceList = createDeviceList();

export const refreshDevices = workspaceList.refresh;
export const useDevices = workspaceList.use;
export const currentDevices = workspaceList.current;
export const onDevicesChange = workspaceList.onChange;

/**
 * Vide la liste et repasse en chargement, à la déconnexion et à chaque bascule
 * d'espace. Sans ça, le nouvel espace démarre avec les appareils du précédent
 * et `loading: false` : l'accueil élague ses tuiles contre une liste étrangère
 * et les supprime définitivement.
 */
export function resetDevices(): void {
    workspaceList.reset();
}
