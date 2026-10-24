import { featureApi } from 'deveye-sdk-client';

import { manifest } from '../manifest';

/** Le client typé sur les commandes du manifest : un nom faux ne compile pas. */
export const api = featureApi(manifest);
