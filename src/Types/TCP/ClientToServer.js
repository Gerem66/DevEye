/**
 * @typedef {import('Types/Feature').FeaturesID} FeaturesID
 * @typedef {import('Types/Password').PasswordType} PasswordType
 */

/**
 * @typedef {Object} RequestClientToServer
 * @property {{ token: string, password: string | null }} login
 * @property {{ contextID: number, password: string }} check-password
 * @property {{ contextID: number }} get-passwords
 * @property {{ contextID: number, passwordID: number }} get-password
 * @property {{ contextID: number, password: PasswordType }} add-password
 * @property {{ contextID: number, password: PasswordType }} edit-password
 * @property {{ contextID: number, passwordID: number }} delete-password
 * @property {{ contextName: string }} add-context
 * @property {{ contextID: number }} delete-context
 * @property {{ contextID: number, featureID: FeaturesID }} change-favorite-context
 * @property {{ contextID: number, type: 'open' | 'close', intervalID?: string }} gamelife-set-loop
 */

export default null;
