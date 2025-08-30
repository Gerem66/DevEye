import fs from 'fs';
import WebSocket from 'websocket';
import { createServer as createHTTPServer } from 'http';
import { createServer } from 'https';

import { GetLocalIP } from '@/Utils/Functions';
import { StrIsJson } from '@/Utils/Types';

import type { Server as HTTPServer } from 'http';
import type { Server as HTTPSServer } from 'https';

import type { TCPRequestSendHeader } from 'deveye-types';
import type { UserType, RequestClientToServer } from 'deveye-types';

export interface ProfileType {
    user: UserType | null;
    connection: WebSocket.connection;
    firstMessage: boolean;
    authentifications: Array<{
        contextID: number;
        clearPassword: string;
        passwordResetTime: number;
        resetTimeout: NodeJS.Timeout | null;
    }>;
}

interface ServerConnectionCallbacks<T extends keyof RequestClientToServer> {
    onConnect: (connection: WebSocket.connection, profile: ProfileType) => void;
    onDisconnect: (connection: WebSocket.connection, profile: ProfileType) => void;
    onMessage: (connection: WebSocket.connection, profile: ProfileType, data: TCPRequestSendHeader<T>) => void;
    onError: (connection: WebSocket.connection, profile: ProfileType, error: Error) => void;
}

class Server {
    server: HTTPServer | HTTPSServer;
    port: number;
    wsServer: WebSocket.server | null;

    constructor() {
        const ENV = process.env.ENVIRONMENT;

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
        this.wsServer = null;
        this.server.on('error', this.onError);
    }

    Listen = (port: number, callbacks: ServerConnectionCallbacks<keyof RequestClientToServer>) => {
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

    onError = (error: Error) => {
        console.error('[WebSocket] Error:', error);
    };

    onRequest = (request: WebSocket.request) => {
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

    onClose = (_connection: WebSocket.connection, reason: number, desc: string) => {
        if (reason !== 1000) {
            console.log('Connection closed:', reason, desc);
        }
    };

    handleNewConnection = (
        connection: WebSocket.connection,
        callbacks: ServerConnectionCallbacks<keyof RequestClientToServer>
    ) => {
        const profile: ProfileType = {
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
