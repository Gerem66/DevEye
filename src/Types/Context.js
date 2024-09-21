/**
 * @typedef {import('./User').TCPUserType} TCPUserType
 * @typedef {import('./Feature').FeaturesID} FeaturesID
 * @typedef {import('../Styles/icons').Icon} Icon
 *
 * @typedef {Object} DBContextType
 * @property {number} ID
 * @property {string} Name
 * @property {string} Logo
 * @property {string} Features JSON string
 * @property {string} Password Hash
 * @property {number | null} ReAuthInterval Interval in seconds for re-authentication (null = never, 0 = always)
 * @property {number} Created
 *
 * @typedef {Object} ContextType
 * @property {number} id Context ID (0 = self)
 * @property {string} name
 * @property {string} logo
 * @property {TCPUserType[]} users
 * @property {FeaturesID[]} features
 * @property {number | null} reAuthInterval Interval in seconds for re-authentication (null = never, 0 = always)
 * @property {number} created
 */

export default null;
