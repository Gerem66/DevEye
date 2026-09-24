import { useSyncExternalStore } from 'react';
import {
    publicMaintenanceSchema,
    type FeatureMaintenanceLevel,
    type MaintenanceState,
    type PublicMaintenance
} from '@deveye/types';

import { getLocal } from '@/api/http';
import { getActiveInstanceId, onWorkspaceChange } from './workspace';

/**
 * La maintenance de chaque instance (`null` : celle-ci), telle que ses sockets
 * la rapportent : à l'ouverture (trame `session`), puis à chaque changement.
 * Une instance distante a la sienne, qui ne regarde que ses espaces.
 */
const OPEN: MaintenanceState = { site: false, message: '', features: {} };
const byInstance = new Map<number | null, MaintenanceState>();
const listeners = new Set<() => void>();

const emit = (): void => {
    for (const fn of listeners) fn();
};

export function setMaintenance(instanceId: number | null, state: MaintenanceState): void {
    byInstance.set(instanceId, state);
    emit();
}

/** Ce qu'en sait un visiteur sans socket : le site seul, les features restant ce qu'elles étaient. */
export function setPublicMaintenance(state: PublicMaintenance): void {
    const known = byInstance.get(null) ?? OPEN;
    if (known.site === state.site && known.message === state.message) return;
    setMaintenance(null, { ...known, ...state });
}

/** Relit l'état public de cette instance ; un échec laisse l'état connu tel quel. */
export async function refreshPublicMaintenance(): Promise<void> {
    try {
        setPublicMaintenance(await getLocal('/api/maintenance', publicMaintenanceSchema));
    } catch {
        // Serveur injoignable : l'écran de démarrage le dit déjà.
    }
}

export function forgetMaintenance(instanceId: number): void {
    if (byInstance.delete(instanceId)) emit();
}

/**
 * Le rappel des administrateurs : démarré sous `MAINTENANCE=1`, pas encore
 * fermé. Livré par le bundle de session, lu au chargement seulement ; il ne
 * s'affiche qu'une fois la maintenance levée.
 */
let envNotice = false;

export function setMaintenanceEnvNotice(value: boolean): void {
    if (value === envNotice) return;
    envNotice = value;
    emit();
}

function subscribe(fn: () => void): () => void {
    listeners.add(fn);
    // L'espace actif peut changer d'instance, et donc de maintenance.
    const off = onWorkspaceChange(fn);
    return () => {
        listeners.delete(fn);
        off();
    };
}

const getActive = (): MaintenanceState => byInstance.get(getActiveInstanceId()) ?? OPEN;
const getHere = (): MaintenanceState => byInstance.get(null) ?? OPEN;

/** La maintenance de l'instance de l'espace actif : ses features, ses tuiles. */
export function useMaintenance(): MaintenanceState {
    return useSyncExternalStore(subscribe, getActive, getActive);
}

/** Celle de cette instance-ci, la seule qui décide d'afficher la page de maintenance. */
export function useSiteMaintenance(): MaintenanceState {
    return useSyncExternalStore(subscribe, getHere, getHere);
}

export function featureMaintenance(state: MaintenanceState, featureId: string): FeatureMaintenanceLevel | null {
    return state.features[featureId] ?? null;
}

const getEnvNotice = (): boolean => envNotice;

export function useMaintenanceEnvNotice(): boolean {
    return useSyncExternalStore(subscribe, getEnvNotice, getEnvNotice);
}
