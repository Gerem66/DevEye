import FeatureDashboard from './Dashboard';
import FeaturePassword from './Password';
import FeatureProfile from './Profile';

/**
 * @typedef {import('Types/Feature').FeatureType} FeatureType
 */

/** @type {FeatureType[]} */
const FEATURES = [
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
        id: 'profile',
        name: 'Profil',
        icon: 'user',
        component: FeatureProfile
    }
];

export { FEATURES };
