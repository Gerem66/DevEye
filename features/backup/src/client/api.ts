import { featureApi } from 'deveye-sdk-client';

import { manifest } from '../manifest';

/** Le client typé des commandes `backup.*` : un seul pour tout le dossier. */
export const api = featureApi(manifest);
