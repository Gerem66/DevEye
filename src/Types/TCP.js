/**
 * @typedef {import('Types/User').UserType} UserType
 * @typedef {import('Types/Password').PasswordType} PasswordType
 * 
 * @typedef {'idle' | 'connected' | 'disconnected' | 'error'} ConnectionState
 * 
 * 
 * 
 * @typedef {Object} SendRequestType
 * @property {{ token: string }} get-user-info
 * @property {{ contextID: number, userID: number, password: string }} check-password
 * @property {{ contextID: number, userID: number }} get-passwords
 * @property {{ contextID: number, userID: number, passwordID: number, password: string }} get-password
 * @property {{ contextID: number, userID: number, password: PasswordType }} add-password
 * @property {{ contextID: number, userID: number, password: PasswordType }} edit-password
 * @property {{ contextID: number, userID: number, passwordID: number }} delete-password
 * 
 * @typedef {Object} ReceiveRequestType
 * @property {{ status: number, user: UserType | null }} get-user-info
 * @property {{ status: number, message: string | null }} check-password
 * @property {{ status: number, passwords: Array<PasswordType> }} get-passwords
 * @property {{ status: number, password: PasswordType | null }} get-password
 * @property {{ status: number, password: PasswordType | null }} add-password
 * @property {{ status: number, password: PasswordType | null }} edit-password
 * @property {{ status: number }} delete-password
 */

/**
 * @template {keyof SendRequestType} T
 * @typedef {Object} TCPRequestSendHeader<T>
 * @property {T} action
 * @property {SendRequestType[T]} content
 * @property {string} [callbackID]
 */

/**
 * @template {keyof ReceiveRequestType} T
 * @typedef {Object} TCPRequestReceiveHeader<T>
 * @property {T} action
 * @property {ReceiveRequestType[T]} content
 * @property {string} [callbackID]
 */

export default null;
