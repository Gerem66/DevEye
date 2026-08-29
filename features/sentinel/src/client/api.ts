import { featureApi, invalidate } from 'deveye-sdk-client';

import { manifest } from '../manifest';

/** L'envoi typé des commandes du module, partagé par toutes ses vues. */
export const api = featureApi(manifest);

/**
 * Après une écriture faite ici : l'émetteur est exclu de la diffusion du sujet
 * `sentinel`, le panneau de réglages doit prévenir lui-même la vue et la carte.
 */
export function refreshSentinelViews(): void {
    invalidate('sentinel.count', 'sentinel.overview', 'sentinel.findings');
}
