import type { FeatureClient } from '@deveye/types/sdk/client';

import Sentinel from './Sentinel';
import SentinelDevicesPanel from './SentinelDevicesPanel';
import SentinelWidget from './SentinelWidget';

export const clientEntry: FeatureClient = {
    Widget: SentinelWidget,
    Full: Sentinel,
    /** L'onglet Appareils : surveillance et cadences, appareil par appareil. */
    settingsPanels: { devices: SentinelDevicesPanel },
    // Démontée à la fermeture : une instance en cache resterait branchée sur le
    // sujet `sentinel` sans que personne la regarde.
    cacheDurationMinutes: 0
};
