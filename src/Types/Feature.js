// TODO

/**
 * @typedef {'dashboard' | 'profile' | 'password' | 'gamelife'} FeaturesID
 * @typedef {import('Styles/iconsf').Icon} Icon
 * @typedef {import('./User').UserType} UserType
 * @typedef {import('./Context').ContextType} ContextType
 *
 * @typedef {Object} FeatureProps
 * @property {UserType} props.user
 * @property {(user: UserType | null) => void} props.setUser
 * @property {ContextType} props.context
 * @property {FeatureType} props.feature
 * @property {(context: ContextType) => void} props.setContext
 * @property {(feature: FeatureType) => void} props.setFeature
 *
 * @typedef {Object} FeatureType
 * @property {FeaturesID} id
 * @property {string} name
 * @property {Icon} icon
 * @property {React.ComponentType<FeatureProps>} component
 */

export default null;
