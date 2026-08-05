import { useEffect, useSyncExternalStore } from 'react';
import { ws } from '@/api/ws';
import { markHomeReady } from '@/stores/homeReady';
import type { Device } from 'deveye-types';

/**
 * Listes d'appareils partagées, interrogées tant qu'un consommateur est monté —
 * le widget, Monitoring et la topbar restent ainsi synchronisés sans se
 * re-fetcher chacun de leur côté. Sondage volontaire : l'abonnement WS aux
 * métriques est global à la socket et appartient à Monitoring, on évite d'y
 * toucher ici pour ne pas créer de conflit d'abonnement.
 *
 * Deux portées, deux listes indépendantes :
 *  - **espace** — les appareils de l'espace actif. C'est le plan de données :
 *    accueil, topbar, Monitoring. Le contenu change à chaque bascule d'espace.
 *  - **flotte** — tous les appareils, tous espaces confondus, réservé aux
 *    administrateurs. C'est ce que gère la page Appareils.
 *
 * Une seule mécanique de sondage, instanciée deux fois : sans ça, la page
 * Appareils et l'accueil se marcheraient dessus en partageant un état qui ne
 * décrit pas le même ensemble.
 */
const POLL_MS = 6000;

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

function createDeviceList(scope: Scope, { signalsHomeReady }: { signalsHomeReady: boolean }): DeviceListStore {
    let state: DevicesState = { devices: [], loading: true, error: null };
    const listeners = new Set<() => void>();
    let timer: ReturnType<typeof setInterval> | null = null;
    let offState: (() => void) | null = null;
    let refCount = 0;

    function emit(next: Partial<DevicesState>): void {
        state = { ...state, ...next };
        for (const fn of listeners) fn();
    }

    async function refresh(): Promise<void> {
        // The socket may still be connecting (page load) or briefly reconnecting.
        // `ws.send` rejects instantly when it isn't open, so polling then would
        // flash a spurious "Connexion indisponible". Stay in the loading state
        // instead and let the onStateChange handler refresh once it opens.
        if (ws.state !== 'open') return;
        try {
            const res = await ws.send('device.list', scope === 'fleet' ? { scope } : {});
            emit({ devices: res.devices, loading: false, error: null });
        } catch {
            emit({ loading: false, error: 'Connexion indisponible' });
        }
        // The device list is the dashboard's main above-the-fold content; once it
        // has first settled (loaded or errored) the home is "ready" enough for
        // the login splash to fade onto a populated view. No-op after the first
        // settle, and only the workspace list gates it — the fleet page is not on
        // the login path.
        if (signalsHomeReady) markHomeReady();
    }

    function subscribe(cb: () => void): () => void {
        listeners.add(cb);
        return () => listeners.delete(cb);
    }

    function start(): void {
        refCount += 1;
        if (refCount !== 1) return;
        void refresh();
        timer = setInterval(() => void refresh(), POLL_MS);
        // Refresh as soon as the socket (re)opens, so the list appears without
        // waiting for the next poll and without an error flash during connect.
        offState = ws.onStateChange((s) => {
            if (s === 'open') void refresh();
        });
    }

    function stop(): void {
        refCount -= 1;
        if (refCount > 0) return;
        refCount = 0;
        if (timer) {
            clearInterval(timer);
            timer = null;
        }
        if (offState) {
            offState();
            offState = null;
        }
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

/** Les appareils de l'espace actif — accueil, topbar, Monitoring. */
const workspaceList = createDeviceList('workspace', { signalsHomeReady: true });

/** Toute la flotte — page Appareils, administrateurs uniquement. */
const fleetList = createDeviceList('fleet', { signalsHomeReady: false });

export const refreshDevices = workspaceList.refresh;
export const useDevices = workspaceList.use;
export const currentDevices = workspaceList.current;
export const onDevicesChange = workspaceList.onChange;

export const useFleetDevices = fleetList.use;

/**
 * Vide les deux listes et repasse en chargement, à la déconnexion **et à chaque
 * bascule d'espace**.
 *
 * Indispensable : sans ça, la nouvelle session (ou le nouvel espace) démarre
 * avec les appareils du précédent et `loading: false`. L'accueil lance alors son
 * élagage des tuiles (`pruneMissingDevices`) contre une liste étrangère et
 * **supprime définitivement** de la disposition les tuiles dont les appareils
 * n'appartenaient pas à l'ensemble d'avant.
 */
export function resetDevices(): void {
    workspaceList.reset();
    fleetList.reset();
}
