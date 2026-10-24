import type { FeatureClient } from '@deveye/types/sdk/client';

import Hits from './Hits';
import Rules from './Rules';

/** L'entrée client : les deux onglets de la popup « Modération », rien d'autre. */
export const clientEntry: FeatureClient = {
    AdminTabs: { rules: Rules, hits: Hits },
    cacheDurationMinutes: 0
};
