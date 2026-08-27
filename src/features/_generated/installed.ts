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
import { manifest as manifest3 } from 'deveye-feature-password';
import { serverEntry as server3 } from 'deveye-feature-password/server';
import { manifest as manifest4 } from 'deveye-feature-notes';
import { serverEntry as server4 } from 'deveye-feature-notes/server';
import { manifest as manifest5 } from 'deveye-feature-uptime';
import { serverEntry as server5 } from 'deveye-feature-uptime/server';
import { manifest as manifest6 } from 'deveye-feature-sentinel';
import { serverEntry as server6 } from 'deveye-feature-sentinel/server';
import { manifest as manifest7 } from 'deveye-feature-backup';
import { serverEntry as server7 } from 'deveye-feature-backup/server';

export const INSTALLED_MODULES: readonly InstalledFeatureModule[] = [
    { manifest: { ...manifest0, icon: 'cloud' }, server: server0 },
    { manifest: { ...manifest1, icon: 'search' }, server: server1 },
    { manifest: { ...manifest2, icon: 'finance' }, server: server2 },
    { manifest: { ...manifest3, icon: 'lock' }, server: server3 },
    { manifest: { ...manifest4, icon: 'notes' }, server: server4 },
    { manifest: { ...manifest5, icon: 'uptime' }, server: server5 },
    { manifest: { ...manifest6, icon: 'shield' }, server: server6 },
    { manifest: { ...manifest7, icon: 'archive' }, server: server7 },
    ...LOCAL_MODULES
];
