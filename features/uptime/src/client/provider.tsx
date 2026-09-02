import type { UptimeClientProvider } from '@deveye/types/sdk/client';

import { api } from './api';
import Ratios from './Ratios';
import { ServiceDialog } from './ServiceDialog';
import StatusBars from './StatusBars';
import { useServiceHistory } from './useServiceHistory';

/**
 * Ce que le module offre aux écrans de l'app (`UPTIME_CLIENT_PROVIDER`) :
 * l'onglet Déploiement d'un projet compose bande d'état, taux et dialogue
 * d'ajout sans importer le module. Un service relié se règle dans l'onglet
 * Général de sa fiche, pas par ce contrat.
 */
export const clientProvider: UptimeClientProvider = {
    listServices: async () => (await api.send('uptime.list', {})).services,
    useServiceHistory,
    StatusBars,
    Ratios,
    // Le dialogue d'ajout de la feature, pas une copie : Projets relie ce qui
    // vient d'être ajouté.
    ServiceDialog
};
