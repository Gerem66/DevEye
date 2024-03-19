import FeatureProfile from '../features/dashboard';
import FeaturePassword from '../features/password';

/**
 * @typedef {'dashboard'|'password'} FeaturesID
 * @typedef {import('../styles/icons').Icon} Icon
 * @typedef {import('./User').UserType} UserType
 * @typedef {import('./Context').ContextType} ContextType
 * 
 * @typedef {Object} FeatureProps
 * @property {UserType} props.user
 * @property {(user: UserType | null) => void} props.setUser
 * @property {ContextType} props.context
 * @property {FeatureType} props.feature
 * 
 * @typedef {Object} FeatureType
 * @property {FeaturesID} id
 * @property {string} name
 * @property {Icon} icon
 * @property {React.ComponentType<FeatureProps>} component
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
