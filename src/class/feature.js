import FeatureProfile from '../features/profile';

/**
 * @typedef {Object} ProjectType
 * @property {string} id
 * @property {string} name
 * @property {string} logo
 * @property {string[]} features
 * 
 * @typedef {Object} FeatureType
 * @property {string} id
 * @property {string} name
 * @property {string} icon
 * @property {(context: ProjectType) => JSX.Element} component
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