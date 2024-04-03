/**
 * @typedef {import('../SQL.js').default} SQL
 * @typedef {import('../Utils/Encryption.js').default} Encryption
 * @typedef {import('../../src/Server.js').ProfileType} ProfileType
 * @typedef {import('Types/TCP.js').SendRequestType} SendRequestType
 * @typedef {import('Types/TCP.js').ReceiveRequestType} ReceiveRequestType
 */

/**
 * @template {keyof SendRequestType} T
 * @typedef {import('Types/TCP.js').TCPRequestSendHeader<T>} TCPRequestSendHeader
 */

/**
 * @template {keyof ReceiveRequestType} T
 * @typedef {import('Types/TCP.js').TCPRequestReceiveHeader<T>} TCPRequestReceiveHeader
 */

/**
 * @typedef {keyof SendRequestType | keyof ReceiveRequestType} RequestTypes
 */

/**
 * @template {RequestTypes} T
 * @typedef {Object} TCPFeatureProps
 * @property {SQL} db
 * @property {Encryption} crypt
 * @property {ProfileType} profile
 * @property {TCPRequestSendHeader<T>['content']} data
 */

/**
 * @template {RequestTypes} T
 * @typedef {(props: TCPFeatureProps<T>) => Promise<TCPRequestReceiveHeader<T>['content']>} TCPFeatureType
 */

export default null;
