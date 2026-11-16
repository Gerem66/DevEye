import { featureApi } from 'deveye-sdk-client';

import { manifest } from '../manifest';

/** L'envoi typé des commandes du module, partagé par toutes ses vues. */
export const api = featureApi(manifest);

/**
 * Tester une clé interroge le store sur chacune de ses capacités : plusieurs
 * secondes, au-delà du délai ordinaire de la socket.
 */
export const STORE_PROBE_TIMEOUT_MS = 90_000;
/** Lister les apps qu'une clé voit est un seul appel au store, parfois lent. */
export const STORE_LIST_TIMEOUT_MS = 30_000;
