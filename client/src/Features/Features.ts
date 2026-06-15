import FeaturePassword from './Password';
import FeatureProfile from './Profile';
import Monitoring from './Monitoring';
import Weather from './Weather';
import Clients from './Clients';
import TwoFactor from './TwoFactor';

import type { FeatureType } from './types';

const FEATURES: FeatureType[] = [
    { id: 'profile', name: 'Profil', icon: 'user', component: FeatureProfile },
    { id: 'password', name: 'Mot de passe', icon: 'lock', component: FeaturePassword },
    { id: 'monitoring', name: 'Monitoring', icon: 'activity', component: Monitoring },
    { id: 'weather', name: 'Météo', icon: 'cloud', component: Weather },
    { id: 'clients', name: 'Appareils', icon: 'server', component: Clients },
    { id: 'twofa', name: 'Sécurité 2FA', icon: 'shield', component: TwoFactor }
];

const FEATURE_BY_ID: Record<string, FeatureType> = Object.fromEntries(FEATURES.map((f) => [f.id, f]));

export { FEATURE_BY_ID, FEATURES };
