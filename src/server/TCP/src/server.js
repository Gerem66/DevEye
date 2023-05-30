import WebSocket from 'websocket';
import { createServer } from 'http';

const debugMode = true;
const Log = (msg, ...items) => debugMode && console.log(msg, ...items);

class Server {
    constructor() {
        this.server = createServer();
        this.server.on('error', this.onError);
    }

    /**
     * @param {number} port
     */
    Listen = (port) => {
        if (!this.server.listening) {
            this.server.listen(port);

            this.wsServer = new WebSocket.server({ httpServer: this.server });
            this.wsServer.addListener('connect', this.onConnect);
            this.wsServer.addListener('request', this.onRequest);
            this.wsServer.addListener('close', this.onClose);
        }
    }

    Stop = () => {
        if (this.server.listening) {
            this.wsServer.shutDown();
            this.server.close();
        }
    }

    /**
     * @param {WebSocket.connection} connection
     */
    onConnect = (connection) => {}

    /**
     * @param {Error} error
     * @private
     */
    onError = (error) => {
        console.error('WebSocket server:', error);
    }

    /**
     * @param {WebSocket.request} request
     * @private
     */
    onRequest = (request) => {
        request.accept('server-multiplayer', request.origin);
    }

    /**
     * @param {WebSocket.connection} connection
     * @param {number} reason
     * @param {string} desc
     * @private
     */
    onClose = (connection, reason, desc) => {
        Log('Connection closed:', reason, desc);
    }
}

export default Server;