/**
 * @typedef {import('../SQL.js').default} SQL
 * @typedef {import('../Utils/Encryption.js').default} Encryption
 * @typedef {import('../Server.js').ProfileType} ProfileType
 * @typedef {import('Types/TCP/TCP.js').RequestClientToServer} RequestClientToServer
 * @typedef {import('Types/TCP/TCP.js').RequestServerToClient} RequestServerToClient
 */

/**
 * @template {keyof RequestClientToServer} T
 * @typedef {import('Types/TCP/TCP.js').TCPRequestSendHeader<T>} TCPRequestSendHeader
 */

/**
 * @template {keyof RequestServerToClient} T
 * @typedef {import('Types/TCP/TCP.js').TCPRequestReceiveHeader<T>} TCPRequestReceiveHeader
 */

/**
 * @typedef {keyof RequestClientToServer | keyof RequestServerToClient} RequestTypes
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
