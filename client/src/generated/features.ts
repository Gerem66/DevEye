/*
 * GÉNÉRÉ par `npm run gen:features` depuis features.config.json. Ne pas éditer :
 * toute modification à la main est écrasée à la prochaine génération, et la CI
 * (`gen:features --check`) refuse un fichier qui ne correspond plus à la config.
 */
import type { InstalledClientFeature } from '@/sdk/registry';

import { LOCAL_CLIENT_FEATURES } from './features.local';
import { manifest as manifest0 } from 'deveye-feature-weather';
import { clientEntry as client0 } from 'deveye-feature-weather/client';
import { manifest as manifest1 } from 'deveye-feature-osint';
import { clientEntry as client1 } from 'deveye-feature-osint/client';
import { manifest as manifest2 } from 'deveye-feature-finance';
import { clientEntry as client2 } from 'deveye-feature-finance/client';
import { manifest as manifest3 } from 'deveye-feature-password';
import { clientEntry as client3 } from 'deveye-feature-password/client';
import { manifest as manifest4 } from 'deveye-feature-notes';
import { clientEntry as client4 } from 'deveye-feature-notes/client';
import { manifest as manifest5 } from 'deveye-feature-uptime';
import { clientEntry as client5 } from 'deveye-feature-uptime/client';
import { manifest as manifest6 } from 'deveye-feature-sentinel';
import { clientEntry as client6 } from 'deveye-feature-sentinel/client';
import { manifest as manifest7 } from 'deveye-feature-backup';
import { clientEntry as client7 } from 'deveye-feature-backup/client';

export const INSTALLED_CLIENT_FEATURES: readonly InstalledClientFeature[] = [
    { manifest: { ...manifest0, icon: 'cloud' }, client: client0 },
    { manifest: { ...manifest1, icon: 'search' }, client: client1 },
    { manifest: { ...manifest2, icon: 'finance' }, client: client2 },
    { manifest: { ...manifest3, icon: 'lock' }, client: client3 },
    { manifest: { ...manifest4, icon: 'notes' }, client: client4 },
    { manifest: { ...manifest5, icon: 'uptime' }, client: client5 },
    { manifest: { ...manifest6, icon: 'shield' }, client: client6 },
    { manifest: { ...manifest7, icon: 'archive' }, client: client7 },
    ...LOCAL_CLIENT_FEATURES
];
