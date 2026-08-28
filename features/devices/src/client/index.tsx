import { DEVICES_CLIENT_PROVIDER } from '@deveye/types/sdk';
import type { DevicesClientProvider, FeatureClient } from '@deveye/types/sdk/client';

import Devices from './Devices';
import DeviceWidget from './DeviceWidget';
import { MonitoringWidget } from './Monitoring';
import MonitoringPanel from './MonitoringPanel';
import DevicesSettingsPanel from './SettingsPanel';
import { refreshDevices, resetDevices, useDevices } from './store';
import DevicesTopbarWidget from './TopbarWidget';

/**
 * Ce que le module offre aux écrans de l'app (`DEVICES_CLIENT_PROVIDER`) :
 * la liste vivante des appareils de l'espace (l'accueil pose une tuile par
 * appareil, le marché les propose), le panneau d'un appareil (la vue qu'une
 * tuile ouvre) et sa tuile. Sans le module, l'accueil ne pose aucun appareil.
 */
const clientProvider: DevicesClientProvider = {
    useDevices,
    refreshDevices: () => void refreshDevices(),
    resetDevices,
    DevicePanel: MonitoringPanel,
    DeviceWidget
};

export const clientEntry: FeatureClient = {
    Widget: MonitoringWidget,
    Full: Devices,
    /**
     * Un seul panneau pour l'onglet Général des deux échelles : les réglages
     * du terminal (feature) et la configuration de collecte d'un appareil
     * (élément, un id texte).
     */
    settingsPanels: { general: DevicesSettingsPanel },
    TopbarWidget: DevicesTopbarWidget,
    cacheDurationMinutes: 5,
    preload: true,
    providers: { [DEVICES_CLIENT_PROVIDER]: clientProvider }
};
