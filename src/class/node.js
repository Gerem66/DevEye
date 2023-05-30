const settings = { host: '127.0.0.1', port: 8080 };

/**
 * TCP server state change event
 * @callback onChangeCallback
 * @param {'connected'|'disconnected'|'error'} state
 */

class Node {
    constructor() {
        /** @type {WebSocket?} */
        this.socket = null;

        /** @type {onChangeCallback} */
        this.onChangeState = (state) => {};
    }

    Connect = () => {
        if (this.isConnected()) {
            console.log('warn', 'Already connected to the node server.');
            return;
        }
        const url = `ws://${settings.host}:${settings.port}`;
        const socket = new WebSocket(url, 'server-multiplayer');
        socket.addEventListener('open', this.onOpen);
        socket.addEventListener('message', this.onMessage);
        socket.addEventListener('error', this.onError);
        socket.addEventListener('close', this.onClose);
        this.socket = socket;
    }
    Disconnect = () => {
        if (this.isConnected()) {
            this.socket.close();
        }
        this.socket = null;
    }
    isConnected = () => {
        return this.socket !== null && this.socket.readyState === WebSocket.OPEN;
    }

    /** @param {Event} event */
    onOpen = (event) => {
        this.Send({ token: 'TOKEN' });
    }
    /** @param {MessageEvent} event */
    onMessage = (event) => {
        if (event.data === 'connected') {
            this.onChangeState('connected');
        } else if (event.data === 'failed') {
            this.onError({ name: 'failed', message: 'Invalid token.' });
        }
    }
    /** @param {Event|Error} event */
    onError = (event) => {
        console.log('error', 'TCP server:', event);
        this.onChangeState('error');
        this.Disconnect();
    }
    /** @param {CloseEvent} event */
    onClose = (event) => {
        if (event.code !== 1000) {
            console.log('error', 'Disconnected:', event);
            this.onChangeState('disconnected');
        }
    }

    /**
     * @param {string|object} message
     * @returns {boolean} Whether the message was sent successfully
     */
    Send = (message) => {
        if (typeof(message) === 'object') message = JSON.stringify(message);
        if (typeof(message) !== 'string') {
            console.log('warn', 'Send socket: Invalid message type.');
        } else {
            if (this.isConnected()) {
                this.socket.send(message);
                return true;
            }
        }
        return false;
    }
}

export default Node;