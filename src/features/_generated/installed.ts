/*
 * GÉNÉRÉ par `npm run gen:features` depuis features.config.json. Ne pas éditer :
 * toute modification à la main est écrasée à la prochaine génération, et la CI
 * (`gen:features --check`) refuse un fichier qui ne correspond plus à la config.
 */
import type { InstalledFeatureModule } from '@/features/_sdk/register';
import { LOCAL_MODULES } from './installed.local';
import { manifest as manifest0 } from 'deveye-feature-weather';
import { serverEntry as server0 } from 'deveye-feature-weather/server';
import { manifest as manifest1 } from 'deveye-feature-osint';
import { serverEntry as server1 } from 'deveye-feature-osint/server';
import { manifest as manifest2 } from 'deveye-feature-finance';
import { serverEntry as server2 } from 'deveye-feature-finance/server';

export const INSTALLED_MODULES: readonly InstalledFeatureModule[] = [
    { manifest: { ...manifest0, icon: 'cloud' }, server: server0 },
    { manifest: { ...manifest1, icon: 'search' }, server: server1 },
    { manifest: { ...manifest2, icon: 'finance' }, server: server2 },
    ...LOCAL_MODULES
];
