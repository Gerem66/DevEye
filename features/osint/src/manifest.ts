import { featureDescriptor } from '@deveye/types';

import { osintCommands } from './contracts/commands';
import type { FeatureManifest } from '@deveye/types/sdk';

/** Le descriptif vient du registre publié ; le manifest n'ajoute que ce que le registre ne porte pas. */
const descriptor = featureDescriptor('osint');

export const manifest = {
    ...descriptor,
    category: 'security',
    /**
     * L'historique et l'usage suivent le sujet de la feature ; les clés ont le leur, pour
     * qu'une recherche ne fasse pas relire les réglages de tout l'espace. Les
     * résultats de sonde se relisent à la demande depuis le cache du serveur.
     */
    resources: ['osint.history', 'osint.usage', 'osint.keyList'],
    invalidatedByTopic: ['osint.history', 'osint.usage'],
    quotas: [{ key: 'lookupsPerMonth', label: 'recherches par mois' }],
    topics: [{ id: 'osintKeys', keys: ['osint.keyList'] }],
    settings: { feature: [{ id: 'probes', label: 'Sondes', icon: 'search' }] },
    commands: osintCommands
} satisfies FeatureManifest;
