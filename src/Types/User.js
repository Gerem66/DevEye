/**
 * @typedef {import('./Feature').FeaturesID} FeaturesID
 * @typedef {import('./Context').ContextType} ContextType
 * 
 * @typedef {Object} DBUserType
 * @property {number} ID
 * @property {string} Email
 * @property {string} Username
 * @property {string} Password
 * @property {string} Avatar
 * @property {string} Features JSON string
 * @property {number} DefaultContext
 * @property {FeaturesID} DefaultFeature
 * @property {string} Settings JSON string
 * @property {string} Token
 * @property {number} LastLogin
 * @property {number} Created
 * 
 * @typedef UserType
 * @property {number} ID
 * @property {string} Email
 * @property {string} Username
 * @property {string} Password
 * @property {string} Avatar
 * @property {ContextType[]} Contexts
 * @property {number} DefaultContext ID of the default context (0 = self)
 * @property {FeaturesID} DefaultFeature
 * @property {string[]} Settings
 * @property {string} Token
 * @property {number} LastLogin
 * @property {number} Created
 * 
 * @typedef TCPUserType
 * @property {number} ID
 * @property {string} Email
 * @property {string} Username
 * @property {string} Avatar
 * @property {number} Created
 */

/** @type {UserType} */
const DefaultUser = {
    ID: 0,
    Email: '',
    Username: '',
    Password: '',
    Avatar: '',
    Settings: [],
    Created: 0,
    LastLogin: 0,
    Contexts: [],
    Token: '',
    DefaultContext: 0,
    DefaultFeature: 'dashboard'
};

export { DefaultUser };
export default null;
