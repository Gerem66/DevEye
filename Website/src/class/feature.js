import FeatureProfile from '../features/dashboard';
import FeaturePassword from '../features/password';

/**
 * @typedef {'dashboard'|'password'} FeaturesID
 * @typedef {import('../styles/icons').Icon} Icon
 * 
 * @typedef {Object} Context
 * @property {string} id
 * @property {string} name
 * @property {string} logo
 * @property {FeaturesID[]} features
 * 
 * @typedef {Object} FeatureType
 * @property {FeaturesID} id
 * @property {string} name
 * @property {Icon} icon
 * @property {(context: Context, feature: FeatureType) => JSX.Element} component
 */

/** @type {FeatureType[]} */
const Features = [
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

export default Features;