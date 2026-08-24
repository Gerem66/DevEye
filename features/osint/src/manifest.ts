import { featureDescriptor } from '@deveye/types';

import { osintCommands } from './contracts/commands';
import type { FeatureManifest } from '@deveye/types/sdk';

/**
 * OSINT, au format manifest : la deuxième native rapatriée sur le SDK.
 *
 * Le descriptif (intitulé, icône, phrase des sources) reste celui du registre
 * publié, étalé plutôt que recopié : une native garde son identité dans
 * @deveye/types, le manifest n'ajoute que ce que le registre ne porte pas
 * (catégorie, onglets, ressources, commandes).
 */
const descriptor = featureDescriptor('osint');

export const manifest = {
    ...descriptor,
    category: 'security',
    /**
     * Une seule clé de cache : l'historique des recherches. Les résultats de
     * sonde ne sont pas une ressource d'espace (ils se relisent à la demande,
     * depuis le cache TTL du serveur), et la liste des clés se recharge à
     * l'ouverture de son panneau.
     */
    resources: ['osint.history'],
    settings: { feature: ['sources'] },
    commands: osintCommands
} satisfies FeatureManifest;
