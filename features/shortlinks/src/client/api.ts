import { featureApi } from 'deveye-sdk-client';

import { manifest } from '../manifest';

/** L'envoi typé des commandes du module, partagé par toutes ses vues. */
export const api = featureApi(manifest);
