import { useEffect, useSyncExternalStore } from 'react';
import { isSocketOpen, onResourceChange, onSocketOpen } from 'deveye-sdk-client';
import type { Device } from '@deveye/types';

import { api } from './api';

/**
 * Listes d'appareils partagées, interrogées tant qu'un consommateur est monté :
 * la tuile, Monitoring, la topbar et l'accueil (par le provider du module)
 * restent ainsi synchronisés sans se re-fetcher chacun de leur côté.
 *
 * Pas de sondage : la liste se relit quand le sujet `devices` bouge, c'est-à-
 * dire sur une commande de flotte, ou quand un agent se connecte ou se
 * déconnecte (l'ingestion le signale au moteur de présence). C'est plus
 * réactif que les six secondes d'un sondage, et strictement muet quand rien ne
 * change.
 *
 * Deux portées, deux listes indépendantes :
 *  - **espace** : les appareils de l'espace actif. C'est le plan de données :
 *    accueil, topbar, Monitoring. Le contenu change à chaque bascule d'espace.
 *  - **flotte** : tous les appareils, tous espaces confondus, réservé aux
 *    administrateurs. C'est ce que gère le segment « Flotte ».
 *
 * Une seule mécanique, instanciée deux fois : sans ça, la flotte et l'accueil
 * se marcheraient dessus en partageant un état qui ne décrit pas le même
 * ensemble.
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
        // La socket peut encore se connecter (chargement de la page) ou se
        // reconnecter : un envoi rejette aussitôt et ferait clignoter un faux
        // « Connexion indisponible ». On reste en chargement, la réouverture
        // relance la lecture.
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
        // Tout de suite si la socket est ouverte, puis à chaque réouverture :
        // la liste paraît sans attendre, et sans erreur pendant la connexion.
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
 * Vide les deux listes et repasse en chargement, à la déconnexion **et à chaque
 * bascule d'espace** (l'app l'appelle par le provider).
 *
 * Indispensable : sans ça, la nouvelle session (ou le nouvel espace) démarre
 * avec les appareils du précédent et `loading: false`. L'accueil lance alors son
 * élagage des tuiles contre une liste étrangère et **supprime définitivement**
 * de la disposition les tuiles dont les appareils n'appartenaient pas à
 * l'ensemble d'avant.
 */
export function resetDevices(): void {
    workspaceList.reset();
    fleetList.reset();
}
