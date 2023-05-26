import FeatureProfile from '../features/profile';

/**
 * @typedef {'profile'} FeaturesID
 * 
 * @typedef {Object} Context
 * @property {string} id
 * @property {string} name
 * @property {string} logo
 * @property {string[]} features
 * 
 * @typedef {Object} FeatureType
 * @property {FeaturesID} id
 * @property {string} name
 * @property {string} icon
 * @property {(context: Context) => JSX.Element} component
 */

/** @type {FeatureType[]} */
const Features = [
    {
        id: 'profile',
        name: 'Profile',
        icon: 'user',
        component: FeatureProfile
    }
];

export default Features;