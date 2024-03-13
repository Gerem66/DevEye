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
    //Contexts: []
    Contexts: [
        {
            id: 'self',
            name: 'Username',
            logo: 'Avatar',
            features: [
                'dashboard',
                'password'
            ]
        },
        {
            id: 'test',
            name: 'test',
            logo: 'default.png',
            features: [
                'dashboard'
            ]
        }
    ],
    Token: ''
};

export { DefaultUser };
export default null;
