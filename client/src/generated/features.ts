/*
 * GÉNÉRÉ par `npm run gen:features` depuis features.config.json. Ne pas éditer :
 * toute modification à la main est écrasée à la prochaine génération, et la CI
 * (`gen:features --check`) refuse un fichier qui ne correspond plus à la config.
 */
import type { FeatureManifest } from '@deveye/types/sdk';
import type { FeatureClient } from '@deveye/types/sdk/client';

import { LOCAL_CLIENT_FEATURES } from './features.local';
import { manifest as manifest0 } from 'deveye-feature-weather';
import { clientEntry as client0 } from 'deveye-feature-weather/client';
import { manifest as manifest1 } from 'deveye-feature-osint';
import { clientEntry as client1 } from 'deveye-feature-osint/client';

export interface InstalledClientFeature {
    manifest: FeatureManifest;
    client: FeatureClient;
}

export const INSTALLED_CLIENT_FEATURES: readonly InstalledClientFeature[] = [
    { manifest: { ...manifest0, icon: 'cloud' }, client: client0 },
    { manifest: { ...manifest1, icon: 'search' }, client: client1 },
    ...LOCAL_CLIENT_FEATURES
];
