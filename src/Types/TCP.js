/**
 * @typedef {import('Types/User').UserType} UserType
 * 
 * @typedef {'idle' | 'connected' | 'disconnected' | 'error'} ConnectionState
 * 
 * 
 * 
 * @typedef {Object} SendRequestGetUserInfo
 * @property {string} token
 * 
 * @typedef {Object} ReceiveRequestGetUserInfo
 * @property {number} status
 * @property {UserType} user
 * 
 * 
 * @typedef {Object} SendRequestTEST
 * @property {string} variablerandom
 * @property {string} [callbackID]
 * 
 * @typedef {Object} ReceiveRequestTEST
 * @property {number} status
 * @property {{ prout: number, caca: string }} yessss
 * 
 * 
 * @typedef {{
 *  'get-user-info': { send: SendRequestGetUserInfo, receive: ReceiveRequestGetUserInfo },
 *  'TEEEEEEST': { send: SendRequestTEST, receive: ReceiveRequestTEST }
 * }} TCPRequestMap
 * 
 * @typedef {Object} TCPRequestHeader
 * @property {keyof TCPRequestMap} action
 * @property {TCPRequestMap[keyof TCPRequestMap]['send' | 'receive']} message
 * @property {string} [callbackID]
 */

export default null;
