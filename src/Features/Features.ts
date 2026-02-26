import FeatureDashboard from './Dashboard';
import FeatureGameLife from './GameLife';
import FeaturePassword from './Password';
import FeatureProfile from './Profile';

import type { FeatureType } from 'deveye-types/Feature';

const FEATURES: FeatureType[] = [
    {
        id: 'profile',
        name: 'Profil',
        icon: 'user',
        component: FeatureProfile
    },
    {
        id: 'dashboard',
        name: 'Dashboard',
        icon: 'home',
        component: FeatureDashboard
    },
    {
        id: 'password',
        name: 'Mot de passe',
        icon: 'lock',
        component: FeaturePassword
    },
    {
        id: 'gamelife',
        name: 'GameLife',
        icon: 'gamelife',
        component: FeatureGameLife
    }
];

export { FEATURES };
