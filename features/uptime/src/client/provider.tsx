import type { SdkTileSummary, UptimeClientProvider } from '@deveye/types/sdk/client';

import { api } from './api';
import { formatRatio } from './format';
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
const STATUS_LABELS = { up: 'En ligne', down: 'Hors ligne', unknown: 'Inconnu' } as const;

/**
 * Un service résumé pour une tuile de tableau de bord. Tout vient de
 * `uptime.list`, qui porte déjà l'état et les taux : un aller-retour pour tous
 * les services d'un projet.
 */
function summarize(serviceIds: readonly number[]): Promise<readonly SdkTileSummary[]> {
    return api.send('uptime.list', {}).then(({ services }) =>
        serviceIds.map((id): SdkTileSummary => {
            const service = services.find((s) => s.id === id);
            if (!service) {
                return {
                    itemId: id,
                    title: `Service #${id}`,
                    metrics: [],
                    unavailable: 'Ce service n’est plus ici.'
                };
            }
            if (!service.enabled) {
                return {
                    itemId: id,
                    title: service.name,
                    metrics: [],
                    unavailable: 'Sa surveillance est en pause.'
                };
            }
            return {
                itemId: id,
                title: service.name,
                metrics: [
                    {
                        key: 'status',
                        label: 'État',
                        value: STATUS_LABELS[service.status],
                        tone: service.status === 'up' ? 'good' : service.status === 'down' ? 'bad' : 'neutral'
                    },
                    { key: 'ratio24h', label: '24 h', value: formatRatio(service.ratio24h) },
                    { key: 'ratio30d', label: '30 j', value: formatRatio(service.ratio30d) }
                ]
            };
        })
    );
}

export const clientProvider: UptimeClientProvider = {
    listServices: async () => (await api.send('uptime.list', {})).services,
    summarize,
    useServiceHistory,
    StatusBars,
    Ratios,
    // Le dialogue d'ajout de la feature, pas une copie : Projets relie ce qui
    // vient d'être ajouté.
    ServiceDialog
};
