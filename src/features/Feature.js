import FeatureProfile from './dashboard';
import FeaturePassword from './password';

/**
 * @typedef {import('Types/Feature').FeatureType} FeatureType
 */

/** @type {FeatureType[]} */
const FEATURES = [
    {
        id: 'dashboard',
        name: 'Dashboard',
        icon: 'user',
        component: FeatureProfile
    },
    {
        id: 'password',
        name: 'Mot de passe',
        icon: 'lock',
        component: FeaturePassword
    }
];

export { FEATURES };
