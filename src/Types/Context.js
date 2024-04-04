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
 * @property {number} Created
 * 
 * @typedef {Object} ContextType
 * @property {number} id Context ID (0 = self)
 * @property {string} name
 * @property {string} logo
 * @property {TCPUserType[]} users
 * @property {FeaturesID[]} features
 * @property {number} created
 */

export default null;
