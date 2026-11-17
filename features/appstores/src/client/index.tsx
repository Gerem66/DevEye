import { APPSTORES_CLIENT_PROVIDER } from '@deveye/types/sdk';
import type { FeatureClient } from '@deveye/types/sdk/client';

import AppGeneralPanel from './AppGeneralPanel';
import AppStores from './AppStores';
import AppStoresWidget from './AppStoresWidget';
import ListingsPanel from './ListingsPanel';
import { clientProvider } from './provider';
import SourcesPanel from './SourcesPanel';

export const clientEntry: FeatureClient = {
    Widget: AppStoresWidget,
    Full: AppStores,
    /**
     * Les comptes de store de l'espace (Sources de la feature) ; l'app elle-même
     * (Général de sa fiche), et ses fiches de store et leur synchronisation (Stores).
     */
    settingsPanels: { sources: SourcesPanel, general: AppGeneralPanel, stores: ListingsPanel },
    // Démonté dès la fermeture : la fiche tient des chiffres bornés par une fenêtre de temps,
    // qui vieilliraient en silence dans une instance gardée en cache.
    cacheDurationMinutes: 0,
    /** Ce que Projets compose : la liste des apps, une app reliée en aperçu, le dialogue d'ajout. */
    providers: { [APPSTORES_CLIENT_PROVIDER]: clientProvider }
};
