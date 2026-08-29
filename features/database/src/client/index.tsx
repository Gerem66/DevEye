import { DATABASE_CLIENT_PROVIDER } from '@deveye/types/sdk';
import type { FeatureClient } from '@deveye/types/sdk/client';

import Database from './Database';
import DatabaseAlertsPanel from './DatabaseAlertsPanel';
import DatabaseGeneralPanel from './DatabaseGeneralPanel';
import DatabaseWidget from './DatabaseWidget';
import { clientProvider } from './provider';

export const clientEntry: FeatureClient = {
    Widget: DatabaseWidget,
    Full: Database,
    /** Les panneaux d'une base : Général (relevé, cadence, chargement des tables) et Alertes. */
    settingsPanels: { general: DatabaseGeneralPanel, alerts: DatabaseAlertsPanel },
    // Démonté dès la fermeture : l'explorateur tient des résultats lus chez un
    // serveur tiers, qui n'ont pas à survivre à l'écran.
    cacheDurationMinutes: 0,
    /** Ce que Projets compose : la liste des bases, une base reliée en entier, le dialogue. */
    providers: { [DATABASE_CLIENT_PROVIDER]: clientProvider }
};
