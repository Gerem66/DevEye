import fs from 'fs';
import WebSocket from 'websocket';
import { createServer as createHTTPServer } from 'http';
import { createServer } from 'https';

import { StrIsJson, GetLocalIP } from './Utils/Functions.js';

/**
 * @typedef {import('Types/TCP.js').TCPRequestHeader} TCPRequestHeader
 * @typedef {import('Types/TCP.js').TCPRequestMap} TCPRequestMap
 * 
 * @typedef {Object} ServerConnectionCallbacks
 * @property {(connection: WebSocket.connection) => void} callbacks.onConnect
 * @property {(connection: WebSocket.connection) => void} callbacks.onDisconnect
 * @property {(connection: WebSocket.connection, data: TCPRequestHeader) => void} callbacks.onMessage
 * @property {(connection: WebSocket.connection, error: Error) => void} callbacks.onError
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
        this.wsServer.addListener('connect', (connection) =>
            this.handleNewConnection(connection, callbacks)
        );

        this.port = port;
        this.server.listen(port);

        console.log('[WebSocket] Listening on', GetLocalIP() + ':' + port);
    }

    Stop = () => {
        if (this.server.listening) {
            this.wsServer.shutDown();
            this.server.close();
            console.log('[WebSocket] Closed');
        }
    }

    /** @param {Error} error */
    onError = (error) => {
        console.error('[WebSocket] Error:', error);
    }

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
    }

    /**
     * @param {WebSocket.connection} connection 
     * @param {number} reason 
     * @param {string} desc 
     */
    onClose = (connection, reason, desc) => {
        if (reason !== 1000) {
            console.log('Connection closed:', reason, desc);
        }
    }

    /**
     * @param {WebSocket.connection} connection
     * @param {ServerConnectionCallbacks} callbacks
     */
    handleNewConnection = (connection, callbacks) => {
        connection.on('message', async (message) => {
            if (message.type !== 'utf8') {
                // TODO: Alert
                return;
            }

            const rawData = message.type === 'utf8' ? message.utf8Data : null;
            if (!StrIsJson(rawData)) {
                // TODO: Alert
                return;
            }

            const data = JSON.parse(rawData);
            if (!data.hasOwnProperty('action') || !data.hasOwnProperty('message')) {
                // TODO: Alert
                return;
            }

            callbacks.onMessage(connection, data);
        });

        connection.on('close', () =>
            callbacks.onDisconnect(connection)
        );

        connection.on('error', (error) =>
            callbacks.onError(connection, error)
        );

        callbacks.onConnect(connection);
    }
}

export default Server;
