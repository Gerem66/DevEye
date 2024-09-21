import fs from 'fs';
import WebSocket from 'websocket';
import { createServer as createHTTPServer } from 'http';
import { createServer } from 'https';

import { StrIsJson, GetLocalIP } from './Utils/Functions.js';

/**
 * @typedef {import('Types/TCP/TCP.js').RequestClientToServer} RequestClientToServer
 * @typedef {import('Types/User.js').UserType} UserType
 *
 * @typedef {Object} ProfileType
 * @property {UserType | null} user
 * @property {WebSocket.connection} connection
 * @property {boolean} firstMessage
 * @property {Array<{ contextID: number, clearPassword: string, passwordResetTime: number, resetTimeout: NodeJS.Timeout | null }>} authentifications
 */

/**
 * @template {keyof RequestClientToServer} T
 * @typedef {import('Types/TCP/TCP.js').TCPRequestSendHeader<T>} TCPRequestSendHeader
 */

/**
 * @typedef {Object} ServerConnectionCallbacks
 * @property {(connection: WebSocket.connection, profile: ProfileType) => void} callbacks.onConnect
 * @property {(connection: WebSocket.connection, profile: ProfileType) => void} callbacks.onDisconnect
 * @property {(connection: WebSocket.connection, profile: ProfileType, data: TCPRequestSendHeader<*>) => void} callbacks.onMessage
 * @property {(connection: WebSocket.connection, profile: ProfileType, error: Error) => void} callbacks.onError
 */

class Server {
    constructor() {
        const ENV = process.env.ENV;

        if (ENV === 'dev') {
            this.server = createHTTPServer({});
            console.warn('[WebSocket] Using HTTP server');
        } else {
            this.server = createServer({
                key: fs.readFileSync('/etc/letsencrypt/live/www.oxyfoo.com/privkey.pem'),
                cert: fs.readFileSync('/etc/letsencrypt/live/www.oxyfoo.com/cert.pem')
            });
        }

        this.port = 0;
        /** @type {WebSocket.server | null} */
        this.wsServer = null;
        this.server.on('error', this.onError);
    }

    /**
     * @param {number} port
     * @param {ServerConnectionCallbacks} callbacks
     */
    Listen = (port, callbacks) => {
        if (this.server.listening) {
            console.log('[WebSocket] Already listening on port', this.port);
            return;
        }

        this.wsServer = new WebSocket.server({ httpServer: this.server });
        this.wsServer.addListener('request', this.onRequest);
        this.wsServer.addListener('close', this.onClose);
        this.wsServer.addListener('connect', (connection) => this.handleNewConnection(connection, callbacks));

        this.port = port;
        this.server.listen(port);

        console.log('[WebSocket] Listening on', GetLocalIP() + ':' + port);
    };

    Stop = () => {
        if (this.server.listening) {
            this.wsServer?.shutDown();
            this.server.close();
            console.log('[WebSocket] Closed');
        }
    };

    /** @param {Error} error */
    onError = (error) => {
        console.error('[WebSocket] Error:', error);
    };

    /** @param {WebSocket.request} request */
    onRequest = (request) => {
        const protocols = request.requestedProtocols;

        // Accept the deveye-only-TX0-CR7 protocol
        const autorizedProtocols = 'deveye-only-tx0-cr7';
        if (protocols.includes(autorizedProtocols)) {
            request.accept(autorizedProtocols, request.origin);
        }

        // Reject all other protocols
        else {
            // TODO: Alert
            request.reject(404, 'Page not found');
        }
    };

    /**
     * @param {WebSocket.connection} connection
     * @param {number} reason
     * @param {string} desc
     */
    onClose = (connection, reason, desc) => {
        if (reason !== 1000) {
            console.log('Connection closed:', reason, desc);
        }
    };

    /**
     * @param {WebSocket.connection} connection
     * @param {ServerConnectionCallbacks} callbacks
     */
    handleNewConnection = (connection, callbacks) => {
        /** @type {ProfileType} */
        const profile = {
            user: null,
            connection,
            firstMessage: true,
            authentifications: []
        };

        connection.on('message', async (message) => {
            if (message.type !== 'utf8') {
                // TODO: Alert
                return;
            }

            const rawData = message.type === 'utf8' ? message.utf8Data : null;
            if (!rawData || !StrIsJson(rawData)) {
                // TODO: Alert
                return;
            }

            const data = JSON.parse(rawData);
            if (
                !Object.prototype.hasOwnProperty.call(data, 'action') ||
                !Object.prototype.hasOwnProperty.call(data, 'content')
            ) {
                // TODO: Alert
                return;
            }

            // Unfortunatly, the first message is always a login
            if (profile.firstMessage && data.action !== 'login') {
                // TODO: Alert
                return;
            }

            callbacks.onMessage(connection, profile, data);
        });

        connection.on('close', () => callbacks.onDisconnect(connection, profile));

        connection.on('error', (error) => callbacks.onError(connection, profile, error));

        callbacks.onConnect(connection, profile);
    };
}

export default Server;
