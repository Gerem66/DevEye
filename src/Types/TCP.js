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
 * @property {{ userID: number, password: string }} check-password
 * @property {{ userID: number }} get-passwords
 * @property {{ userID: number, passwordID: number }} get-password
 * 
 * @typedef {Object} ReceiveRequestType
 * @property {{ status: number, user: UserType }} get-user-info
 * @property {{ status: number }} check-password
 * @property {{ status: number, passwords: Array<PasswordType> }} get-passwords
 * @property {{ status: number, password: PasswordType }} get-password
 */

/**
 * @template {keyof ReceiveRequestType} T
 * @typedef {Object} TCPRequestHeader<T>
 * @property {T} action
 * @property {SendRequestType[T] | ReceiveRequestType[T]} message
 * @property {string} [callbackID]
 */

export default null;
