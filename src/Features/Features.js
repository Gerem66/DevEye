import FeatureDashboard from './Dashboard';
import FeaturePassword from './Password';

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
        id: 'profile',
        name: 'Profil',
        icon: 'user',
        component: FeatureDashboard
    },
    {
        id: 'password',
        name: 'Mot de passe',
        icon: 'lock',
        component: FeaturePassword
    }
];

export { FEATURES };
