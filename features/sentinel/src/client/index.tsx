import type { FeatureClient } from '@deveye/types/sdk/client';

import Sentinel from './Sentinel';
import SentinelDevicesPanel from './SentinelDevicesPanel';
import SentinelWidget from './SentinelWidget';

export const clientEntry: FeatureClient = {
    Widget: SentinelWidget,
    Full: Sentinel,
    /** L'onglet Appareils : surveillance et cadences, appareil par appareil. */
    settingsPanels: { devices: SentinelDevicesPanel },
    // Démontée à la fermeture : la vue relit constats et posture à
    // l'ouverture, et une instance en cache resterait branchée sur le sujet
    // `sentinel` sans que personne la regarde. La carte de l'accueil reste
    // vivante par le compteur partagé, comme celle d'Uptime.
    cacheDurationMinutes: 0
};
