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
    /**
     * Les deux panneaux d'une BASE : Général (le relevé périodique, sa
     * cadence, le chargement des tables à l'ouverture) et l'onglet
     * personnalisé Alertes (les règles, derrière le dialogue de la feature).
     */
    settingsPanels: { general: DatabaseGeneralPanel, alerts: DatabaseAlertsPanel },
    // Démonté dès la fermeture, comme Git : l'explorateur de tables tient
    // des résultats lus chez un serveur tiers, qui n'ont aucune raison de
    // survivre à la fermeture de l'écran. Pas de `holdSecrecy` : rien n'y
    // est chiffré à l'étage gardé.
    cacheDurationMinutes: 0,
    /** Ce que Projets compose : la liste des bases, une base reliée en entier, le dialogue. */
    providers: { [DATABASE_CLIENT_PROVIDER]: clientProvider }
};
