import { RandomString } from './Functions';

import type { ConnectionState, RequestCommands, TCPRequestReceiveHeader } from 'deveye-types';

const VPS_CREDENTIALS = {
    env: import.meta.env.MODE,
    host: import.meta.env.VITE_VPS_IP,
    port: import.meta.env.VITE_VPS_PORT
};

class ClientTCP {
    socket: WebSocket | null = null;

    state: ConnectionState = 'idle';

    callbackClose = () => {};

    private callbacks: {
        [key: string]: <T extends keyof RequestCommands>(data: RequestCommands[T]['output']) => boolean;
    } = {};

    Connect = async (onCloseCallback: () => void): Promise<boolean> => {
        // If already connected, or if the user is not connected to the server
        if (this.IsConnected()) {
            return true;
        }

        const protocol = VPS_CREDENTIALS.env === 'development' ? 'ws' : 'wss';
        const url = `${protocol}://${VPS_CREDENTIALS.host}:${VPS_CREDENTIALS.port}`;
        const socket = new WebSocket(url, 'deveye-only-tx0-cr7');
        socket.addEventListener('open', this.onOpen);
        socket.addEventListener('message', this.onMessage);
        socket.addEventListener('close', this.onClose);
        this.socket = socket;

        // Wait until connected or error && reset listener
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                resolve(false);
            }, 1000);

            socket.addEventListener('open', () => {
                clearTimeout(timer);
                socket.removeEventListener('open', this.onOpen);
                socket.removeEventListener('error', this.onError);
                socket.addEventListener('error', this.onError);
                this.callbackClose = onCloseCallback;
                resolve(true);
            });

            socket.addEventListener('error', () => {
                clearTimeout(timer);
                resolve(false);
            });
        });
    };

    Disconnect = () => {
        if (this.socket !== null && this.IsConnected()) {
            this.socket.close();
        }
        this.socket = null;
        console.log('[TCP] Disconnected from server');
    };

    IsConnected = () => {
        return this.socket?.readyState === WebSocket.OPEN;
    };

    private onOpen = (event: Event) => {
        void event;
        console.log('[TCP] Connected to server');
    };

    private onMessage = (event: MessageEvent) => {
        const data = JSON.parse(event.data) as TCPRequestReceiveHeader;

        if (Object.prototype.hasOwnProperty.call(data, 'callbackID') && data.callbackID) {
            const callbackID = data.callbackID;
            const callback = this.callbacks[callbackID];
            if (typeof callback === 'function') {
                const removeCallback = callback(data.content);
                if (removeCallback) {
                    delete this.callbacks[callbackID];
                }
            } else {
                console.log('[TCP] Callback not found:', callbackID);
            }
        }
    };

    private onError = (event: Event) => {
        console.log('[TCP] TCP server:', event);
        this.state = 'error';
    };

    private onClose = (event: CloseEvent) => {
        void event;
        this.state = 'disconnected';
        this.Disconnect();
        this.callbackClose();
    };

    Send = (
        action: keyof RequestCommands,
        content: RequestCommands[typeof action]['input'],
        callbackID?: string
    ): boolean => {
        if (typeof content !== 'object') {
            console.warn('[TCP] Send socket: Invalid message type.');
            return false;
        }

        if (this.socket === null || !this.IsConnected()) {
            console.warn('[TCP] Send socket: Not connected.');
            return false;
        }

        const data = { action, callbackID, content };
        this.socket.send(JSON.stringify(data));
        return true;
    };

    /**
     * @param callback A callback function that will be called when the response is received. If it returns true, the callback will be removed.
     * @param timeout in ms
     */
    SendAndWait = async <T extends keyof RequestCommands>(
        action: T,
        data: RequestCommands[T]['input'],
        callback: (data: RequestCommands[T]['output']) => boolean = () => true,
        timeout = 10000
    ): Promise<'not-sended' | 'timeout' | RequestCommands[T]['output']> => {
        const callbackID = RandomString(8);
        const sended = this.Send(action, data, callbackID);

        if (sended === false) {
            return Promise.resolve('not-sended');
        }

        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                delete this.callbacks[callbackID];
                resolve('timeout');
            }, timeout);

            this.callbacks[callbackID] = (data: RequestCommands[T]['output']) => {
                const finished = callback(data);

                if (finished) {
                    clearTimeout(timer);
                    resolve(data);
                    return true;
                }

                return false;
            };
        });
    };
}

const tcp = new ClientTCP();

export { tcp };
export default ClientTCP;
