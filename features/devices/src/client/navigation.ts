import { useSyncExternalStore } from 'react';
import { openFeature } from 'deveye-sdk-client';

/**
 * L'intention « ouvrir la flotte » : le segment vit dans `Devices.tsx`, mais
 * qui le demande peut être ailleurs (le panneau d'un appareil ouvert depuis
 * l'accueil). On pose l'intention, on ouvre la feature par l'hôte (une
 * téléportation), et la vue la consomme au montage ou au prochain rendu.
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
