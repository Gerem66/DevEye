import FeatureProfile from '../features/dashboard';
import FeaturePassword from '../features/password';

/**
 * @typedef {'dashboard'|'password'} FeaturesID
 * @typedef {import('../styles/icons').Icon} Icon
 * @typedef {import('./Context').ContextType} ContextType
 * 
 * @typedef {Object} FeatureType
 * @property {FeaturesID} id
 * @property {string} name
 * @property {Icon} icon
 * @property {(context: ContextType, feature: FeatureType) => JSX.Element} component
 */

/** @type {FeatureType[]} */
const AllFeatures = [
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

export { AllFeatures };
export default null;
