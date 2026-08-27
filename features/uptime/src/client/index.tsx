import { UPTIME_CLIENT_PROVIDER } from '@deveye/types/sdk';
import type { FeatureClient } from '@deveye/types/sdk/client';

import { clientProvider } from './provider';
import ServiceGeneralPanel from './ServiceGeneralPanel';
import UptimeTopbarWidget from './TopbarWidget';
import Uptime from './Uptime';
import UptimeWidget from './UptimeWidget';

export const clientEntry: FeatureClient = {
    Widget: UptimeWidget,
    Full: Uptime,
    /** Le panneau Général d'un service (cadence, délai, seuil, rétention). */
    settingsPanels: { general: ServiceGeneralPanel },
    TopbarWidget: UptimeTopbarWidget,
    // Unmounted as soon as it closes: the panel re-queries while it lives, and a
    // cached (or preloaded) instance would keep querying unseen. The home
    // card and the topbar widget stay live through the shared count store.
    cacheDurationMinutes: 0,
    /** Ce que Projets compose : bande d'état, taux, historique, dialogue. */
    providers: { [UPTIME_CLIENT_PROVIDER]: clientProvider }
};
