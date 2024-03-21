/**
 * @typedef {import('./Feature').FeaturesID} FeaturesID
 * @typedef {import('./Context').ContextType} ContextType
 * 
 * @typedef UserType
 * @property {number} ID
 * @property {string} Email
 * @property {string} Username
 * @property {string} Password
 * @property {string} Avatar
 * @property {string[]} Settings
 * @property {number} Created
 * @property {ContextType[]} Contexts
 * @property {string} Token
 * @property {number} DefaultContext ID of the default context (0 = self)
 * @property {FeaturesID} DefaultFeature
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
    Contexts: [],
    Token: '',
    DefaultContext: 0,
    DefaultFeature: 'dashboard'
};

export { DefaultUser };
export default null;
