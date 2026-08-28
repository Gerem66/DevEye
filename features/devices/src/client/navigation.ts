import { useSyncExternalStore } from 'react';
import { openFeature } from 'deveye-sdk-client';

/**
 * L'intention « ouvrir la flotte », la navigation interne du module.
 *
 * Le segment « Flotte » vit dans la vue complète (`Devices.tsx`), mais celui
 * qui le demande peut être ailleurs : le panneau d'un appareil ouvert depuis
 * une tuile de l'accueil (« Gérer les appareils »). On pose l'intention, on
 * ouvre la feature par l'hôte (une téléportation, la garde d'accès reste la
 * sienne), et la vue la consomme à son montage ou à son prochain rendu si
 * elle est déjà là, parquée ou visible.
 */
let wanted = false;
let version = 0;
const listeners = new Set<() => void>();

export function openFleet(): void {
    wanted = true;
    version += 1;
    for (const fn of listeners) fn();
    openFeature('devices');
}

/** Consomme l'intention : `true` une fois, puis `false` jusqu'à la suivante. */
export function takeFleetIntent(): boolean {
    const was = wanted;
    wanted = false;
    return was;
}

/** Un nombre qui change à chaque intention posée : à mettre en dépendance d'un effet. */
export function useFleetIntent(): number {
    return useSyncExternalStore(
        (fn) => {
            listeners.add(fn);
            return () => listeners.delete(fn);
        },
        () => version,
        () => version
    );
}
