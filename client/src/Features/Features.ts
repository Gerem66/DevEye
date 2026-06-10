import FeatureDashboard from './Dashboard';
import FeatureGameLife from './GameLife';
import FeaturePassword from './Password';
import FeatureProfile from './Profile';

import type { FeatureType } from './types';

const FEATURES: FeatureType[] = [
    { id: 'profile', name: 'Profil', icon: 'user', component: FeatureProfile },
    { id: 'dashboard', name: 'Dashboard', icon: 'home', component: FeatureDashboard },
    { id: 'password', name: 'Mot de passe', icon: 'lock', component: FeaturePassword },
    { id: 'gamelife', name: 'GameLife', icon: 'gamelife', component: FeatureGameLife }
];

const FEATURE_BY_ID: Record<string, FeatureType> = Object.fromEntries(FEATURES.map((f) => [f.id, f]));

export { FEATURE_BY_ID, FEATURES };
