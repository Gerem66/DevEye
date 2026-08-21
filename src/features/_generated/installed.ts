/*
 * GÉNÉRÉ par `npm run gen:features` depuis features.config.json. Ne pas éditer :
 * toute modification à la main est écrasée à la prochaine génération, et la CI
 * (`gen:features --check`) refuse un fichier qui ne correspond plus à la config.
 */
import type { InstalledFeatureModule } from '@/features/_sdk/register';
import { manifest as manifest0 } from 'deveye-feature-weather';
import { serverEntry as server0 } from 'deveye-feature-weather/server';

export const INSTALLED_MODULES: readonly InstalledFeatureModule[] = [
    { manifest: { ...manifest0, icon: 'cloud' }, server: server0 }
];
