import fs from 'fs';
import WebSocket from 'websocket';
import { createServer as createHTTPServer } from 'http';
import { createServer } from 'https';

import { StrIsJson, GetLocalIP } from './Utils/Functions.js';

/**
 * @typedef {Object} ServerConnectionCallbacks
 * @property {(connection: WebSocket.connection) => void} callbacks.onConnect
 * @property {(connection: WebSocket.connection) => void} callbacks.onDisconnect
 * @property {(connection: WebSocket.connection, data: Object) => void} callbacks.onMessage
 * @property {(connection: WebSocket.connection, error: Error) => void} callbacks.onError
 */

class Server {
    constructor() {
        const ENV = process.env.ENV;

        if (ENV === 'dev') {
            this.server = createHTTPServer({});
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

        this.port = port;
        this.server.listen(port);

        this.wsServer = new WebSocket.server({ httpServer: this.server });
        this.wsServer.addListener('request', this.onRequest);
        this.wsServer.addListener('close', this.onClose);
        this.wsServer.addListener('connect', (connection) =>
            this.handleNewConnection(connection, callbacks)
        );

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
        const protocol = request.requestedProtocols;

        // Accept the deveye-only-TX0-CR7 protocol
        if (protocol.indexOf('deveye-only-TX0-CR7') !== -1) {
            request.accept('deveye-only-TX0-CR7', request.origin);
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
        if (!this.checkProtocol(connection)) {
            console.log('Invalid protocol, closing connection');
            return;
        }

        connection.on('message', async (message) => {
            if (message.type !== 'utf8') {
                return;
            }

            const rawData = message.type === 'utf8' ? message.utf8Data : null;
            if (!StrIsJson(rawData)) {
                return;
            }

            const data = JSON.parse(rawData);
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

    /**
     * @param {WebSocket.connection} connection
     * @returns {boolean}
     */
    checkProtocol = (connection) => {
        const protocol = connection.protocol;
        if (protocol === 'deveye-only-TX0-CR7') {
            return true;
        }
        return false;
    }
}

export default Server;
