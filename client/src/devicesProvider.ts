import { DEVICES_CLIENT_PROVIDER } from '@deveye/types/sdk';
import type { DevicesClientProvider, SdkDeviceSummary } from '@deveye/types/sdk/client';

import { moduleClientProvider } from '@/sdk/registry';

/**
 * Les appareils, vus de l'app : ce que le module Appareils offre par
 * `DEVICES_CLIENT_PROVIDER`, et rien d'autre. L'app ne tient aucune liste
 * d'appareils elle-même ; sans le module, elle n'en connaît aucun.
 */
export function devicesProvider(): DevicesClientProvider | undefined {
    return moduleClientProvider<DevicesClientProvider>(DEVICES_CLIENT_PROVIDER);
}

export interface DevicesSnapshot {
    devices: readonly SdkDeviceSummary[];
    loading: boolean;
    error: string | null;
}

/**
 * Sans module : une liste vide, chargée, sans erreur. Les écrans qui doivent
 * distinguer « rien d'installé » de « rien d'enrôlé » lisent
 * {@link devicesProvider} eux-mêmes.
 */
const NO_DEVICES: DevicesSnapshot = { devices: [], loading: false, error: null };

/**
 * La liste vivante des appareils de l'espace actif, par le provider du module. Il
 * est lu au rendu, jamais à l'import : le registre est rempli par l'initialiseur
 * avant le premier rendu et n'en bouge plus, donc la suite des hooks d'un
 * composant est la même à chaque fois.
 */
export function useDevices(): DevicesSnapshot {
    const provider = devicesProvider();
    return provider ? provider.useDevices() : NO_DEVICES;
}
