import { featureDescriptor } from '@deveye/types';

import { osintCommands } from './contracts/commands';
import type { FeatureManifest } from '@deveye/types/sdk';

/** Le descriptif vient du registre publié ; le manifest n'ajoute que ce que le registre ne porte pas. */
const descriptor = featureDescriptor('osint');

export const manifest = {
    ...descriptor,
    category: 'security',
    /**
     * Une seule clé de cache : l'historique. Les résultats de sonde se relisent à
     * la demande depuis le cache TTL du serveur.
     */
    resources: ['osint.history'],
    settings: { feature: ['sources'] },
    commands: osintCommands
} satisfies FeatureManifest;
