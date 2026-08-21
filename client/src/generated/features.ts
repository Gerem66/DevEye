/*
 * GÉNÉRÉ par `npm run gen:features` depuis features.config.json. Ne pas éditer :
 * toute modification à la main est écrasée à la prochaine génération, et la CI
 * (`gen:features --check`) refuse un fichier qui ne correspond plus à la config.
 */
import type { FeatureManifest } from 'deveye-types/sdk';
import type { FeatureClient } from 'deveye-types/sdk/client';

export interface InstalledClientFeature {
    manifest: FeatureManifest;
    client: FeatureClient;
}

export const INSTALLED_CLIENT_FEATURES: readonly InstalledClientFeature[] = [];
