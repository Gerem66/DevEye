import { featureApi, invalidate } from 'deveye-sdk-client';

import { manifest } from '../manifest';

/** L'envoi typé des commandes du module, partagé par toutes ses vues. */
export const api = featureApi(manifest);

/**
 * Ravive tout ce que l'écran montre après une écriture faite ICI.
 *
 * Le dispatcheur diffuse le sujet `sentinel` aux autres membres après une
 * commande mutante, mais l'émetteur en est exclu (il tient déjà sa réponse) :
 * le panneau de réglages, qui n'est pas la vue, doit donc prévenir lui-même
 * la vue et la carte d'accueil restées derrière lui.
 */
export function refreshSentinelViews(): void {
    invalidate('sentinel.count', 'sentinel.overview', 'sentinel.findings');
}
