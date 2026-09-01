import { DEVICES_CLIENT_PROVIDER } from '@deveye/types/sdk';
import type { DevicesClientProvider, FeatureClient } from '@deveye/types/sdk/client';

import Devices from './Devices';
import DeviceWidget from './DeviceWidget';
import { MonitoringWidget } from './Monitoring';
import MonitoringPanel from './MonitoringPanel';
import { DevicesCollectPanel, DevicesTerminalPanel } from './SettingsPanel';
import { refreshDevices, resetDevices, useDevices } from './store';
import DevicesTopbarWidget from './TopbarWidget';

/**
 * Ce que le module offre aux écrans de l'app (`DEVICES_CLIENT_PROVIDER`) : la
 * liste vivante des appareils de l'espace, le panneau d'un appareil et sa tuile.
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
    /** Les deux onglets d'un appareil : sa collecte et son terminal. */
    settingsPanels: { collect: DevicesCollectPanel, terminal: DevicesTerminalPanel },
    TopbarWidget: DevicesTopbarWidget,
    cacheDurationMinutes: 5,
    preload: true,
    providers: { [DEVICES_CLIENT_PROVIDER]: clientProvider }
};
