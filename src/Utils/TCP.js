const VPS_CREDENTIALS = {
    env: process.env.NODE_ENV,
    host: process.env.REACT_APP_VPS_IP,
    port: process.env.REACT_APP_VPS_PORT
};

/**
 * @typedef {import('Types/TCP').ConnectionState} ConnectionState
 * @typedef {import('Types/TCP').TCPRequestMap} TCPRequestMap
 */

class ClientTCP {
    /** @type {WebSocket | null} */
    socket = null;

    /** @type {ConnectionState} */
    state = 'idle';

    callbacks = {};

    /**
     * @returns {boolean} Whether the connection was successful, or if it was already connected
     */
    Connect = () => {
        // If already connected, or if the user is not connected to the server
        if (this.IsConnected()) {
            return false;
        }

        const protocol = VPS_CREDENTIALS.env === 'development' ? 'ws' : 'wss';
        const url = `${protocol}://${VPS_CREDENTIALS.host}:${VPS_CREDENTIALS.port}`;
        const socket = new WebSocket(url, 'deveye-only-tx0-cr7');
        socket.addEventListener('open', this.onOpen);
        socket.addEventListener('message', this.onMessage);
        socket.addEventListener('error', this.onError);
        socket.addEventListener('close', this.onClose);
        this.socket = socket;
    }

    Disconnect = () => {
        if (this.IsConnected()) {
            this.socket.close();
        }
        this.socket = null;
    }

    IsConnected = () => {
        return this.socket !== null && this.socket.readyState === WebSocket.OPEN;
    }

    /** @param {Event} event */
    onOpen = (event) => {
        console.log('[TCP] Connected to server');
        const data = { token: '' };
        //this.socket.send(JSON.stringify(data));
    }

    /** @param {MessageEvent} event */
    onMessage = (event) => {
        /**
         * @template {keyof TCPRequestMap} T
         * @type {{ action: T, message: TCPRequestMap[T]['receive'] }}
         */
        const data = JSON.parse(event.data);

        if (data.action === 'get-user-info') {
            data.message.status = 0
        } else if (data.action === 'TEEEEEEST') {
            data.message.status = 0
        }

        if (data.hasOwnProperty('callbackID')) {
            const callbackID = data['callbackID'];
            const callback = this.callbacks[callbackID];
            if (typeof(callback) === 'function') {
                callback(data);
                delete this.callbacks[callbackID];
            } else {
                console.log('[TCP] Callback not found:', callbackID);
            }
        }
    }

    /** @param {Event} event */
    onError = (event) => {
        console.log('[TCP] TCP server:', event);
        this.state = 'error';
        this.Disconnect();
    }

    /** @param {CloseEvent} event */
    onClose = (event) => {
        this.state = 'disconnected';
        this.Disconnect();
    }

    /**
     * @template {keyof TCPRequestMap} T
     * @param {T} action
     * @param {TCPRequestMap[T]['send']} message
     * @param {string} [callbackID]
     * @returns {boolean} Whether the message was sent successfully
     */
    Send = (action, message, callbackID) => {
        if (typeof(message) !== 'object') {
            console.log('[TCP] Send socket: Invalid message type.');
            return false;
        }

        if (this.IsConnected() === false) {
            console.log('[TCP] Send socket: Not connected.');
            return false;
        }

        const data = { action, callbackID, message };
        this.socket.send(JSON.stringify(data));
        return true;
    }

    /**
     * @template {keyof TCPRequestMap} T
     * @param {T} action
     * @param {TCPRequestMap[T]['send']} message
     * @param {number} [timeout] in milliseconds
     * @returns {Promise<'not-sended' | 'timeout' | TCPRequestMap[T]['receive']>} The result of the callback or 'timeout' if it took too long
     */
    SendAndWaitForCallback = (action, message, timeout = 10000) => {
        const callbackID = action + '-' + Math.random().toString(36).substring(7);
        const sended = this.Send(action, message, callbackID);

        if (sended === false) {
            return Promise.resolve('not-sended');
        }

        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                resolve('timeout');
            }, timeout);
            this.callbacks[callbackID] = (data) => {
                clearTimeout(timer);
                resolve(data['result']);
            };
        });
    }
}

export default ClientTCP;

(async () => {
    const client = new ClientTCP();
    const resultGetUserInfo = await client.SendAndWaitForCallback('TEEEEEEST', {
        variablerandom: 'username'
    });
    if (resultGetUserInfo === 'not-sended') {
    } else if (resultGetUserInfo === 'timeout') {
    } else if (resultGetUserInfo.status === 0) {
        resultGetUserInfo.yessss.caca
    }
})
