/**
 * @typedef {import('./ClientToServer').RequestClientToServer} RequestClientToServer
 * @typedef {import('./ServerToClient').RequestServerToClient} RequestServerToClient
 */

/**
 * @typedef {'idle' | 'connected' | 'disconnected' | 'error'} ConnectionState
 */

/**
 * @template {keyof RequestClientToServer} T
 * @typedef {Object} TCPRequestSendHeader<T>
 * @property {T} action
 * @property {RequestClientToServer[T]} content
 * @property {string} [callbackID]
 */

/**
 * @template {keyof RequestServerToClient} T
 * @typedef {Object} TCPRequestReceiveHeader<T>
 * @property {T} action
 * @property {RequestServerToClient[T]} content
 * @property {string} [callbackID]
 */

export default null;
