/**
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
 * @property {string} SelectedContext
 * @property {string} SelectedFeature
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
    SelectedContext: 'self',
    SelectedFeature: 'dashboard'
};

export { DefaultUser };
export default null;
