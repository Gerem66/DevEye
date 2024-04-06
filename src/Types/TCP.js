/**
 * @typedef {import('Types/User').UserType} UserType
 * @typedef {import('Types/User').ContextType} ContextType
 * @typedef {import('Types/Feature').FeaturesID} FeaturesID
 * @typedef {import('Types/Password').PasswordType} PasswordType
 * 
 * @typedef {'idle' | 'connected' | 'disconnected' | 'error'} ConnectionState
 * 
 * 
 * 
 * @typedef {Object} SendRequestType
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
 * 
 * @typedef {Object} ReceiveRequestType
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
