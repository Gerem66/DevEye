/**
 * @typedef {import('Types/User').UserType} UserType
 * @typedef {import('Types/User').ContextType} ContextType
 * @typedef {import('Types/Password').PasswordType} PasswordType
 */

/**
 * @typedef {Object} RequestServerToClient
 * @property {{ status: number, user: UserType | null }} login
 * @property {{ status: number, message: string | null }} check-password
 * @property {{ status: number, passwords: Array<PasswordType> }} get-passwords
 * @property {{ status: number, password: PasswordType | null }} get-password
 * @property {{ status: number, password: PasswordType | null }} add-password
 * @property {{ status: number, password: PasswordType | null }} edit-password
 * @property {{ status: number }} delete-password
 * @property {{ status: number, context: ContextType | null }} add-context
 * @property {{ status: number }} delete-context
 * @property {{ status: number }} change-favorite-context
 * @property {{ status: number, intervalID: string }} gamelife-set-loop
 * @property {{ status: number, totalUserCount: number }} gamelife-data
 */

export default null;
