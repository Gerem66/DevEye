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
import { manifest as manifest8 } from 'deveye-feature-database';
import { serverEntry as server8 } from 'deveye-feature-database/server';
import { manifest as manifest9 } from 'deveye-feature-deploy';
import { serverEntry as server9 } from 'deveye-feature-deploy/server';
import { manifest as manifest10 } from 'deveye-feature-git';
import { serverEntry as server10 } from 'deveye-feature-git/server';
import { manifest as manifest11 } from 'deveye-feature-audience';
import { serverEntry as server11 } from 'deveye-feature-audience/server';
import { manifest as manifest12 } from 'deveye-feature-mail';
import { serverEntry as server12 } from 'deveye-feature-mail/server';
import { manifest as manifest13 } from 'deveye-feature-projects';
import { serverEntry as server13 } from 'deveye-feature-projects/server';
import { manifest as manifest14 } from 'deveye-feature-devices';
import { serverEntry as server14 } from 'deveye-feature-devices/server';
import { manifest as manifest15 } from 'deveye-feature-cve';
import { serverEntry as server15 } from 'deveye-feature-cve/server';
import { manifest as manifest16 } from 'deveye-feature-mailserver';
import { serverEntry as server16 } from 'deveye-feature-mailserver/server';

export const INSTALLED_MODULES: readonly InstalledFeatureModule[] = [
    { manifest: { ...manifest0, icon: 'cloud' }, server: server0 },
    { manifest: { ...manifest1, icon: 'search' }, server: server1 },
    { manifest: { ...manifest2, icon: 'finance' }, server: server2 },
    { manifest: { ...manifest3, icon: 'lock' }, server: server3 },
    { manifest: { ...manifest4, icon: 'notes' }, server: server4 },
    { manifest: { ...manifest5, icon: 'uptime' }, server: server5 },
    { manifest: { ...manifest6, icon: 'shield' }, server: server6 },
    { manifest: { ...manifest7, icon: 'archive' }, server: server7 },
    { manifest: { ...manifest8, icon: 'database' }, server: server8 },
    { manifest: { ...manifest9, icon: 'rocket' }, server: server9 },
    { manifest: { ...manifest10, icon: 'branch' }, server: server10 },
    { manifest: { ...manifest11, icon: 'eye-open' }, server: server11 },
    { manifest: { ...manifest12, icon: 'mail' }, server: server12 },
    { manifest: { ...manifest13, icon: 'projects' }, server: server13 },
    { manifest: { ...manifest14, icon: 'server' }, server: server14 },
    { manifest: { ...manifest15, icon: 'bug' }, server: server15 },
    { manifest: { ...manifest16, icon: 'at' }, server: server16 },
    ...LOCAL_MODULES
];
