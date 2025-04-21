const VPS_CREDENTIALS = {
    env: process.env.NODE_ENV,
    host: process.env.REACT_APP_VPS_IP,
    port: process.env.REACT_APP_VPS_PORT
};

type ConnectionState = import('Types/TCP/TCP').ConnectionState;
type RequestClientToServer = import('Types/TCP/TCP').RequestClientToServer;
type RequestServerToClient = import('Types/TCP/TCP').RequestServerToClient;

class ClientTCP {
    socket: WebSocket | null = null;

    state: ConnectionState = 'idle';

    callbackClose = () => {};

    callbacks: { [key: string]: (data: any) => boolean } = {};

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

    onOpen = (event: Event) => {
        void event;
        console.log('[TCP] Connected to server');
    };

    onMessage = (event: MessageEvent) => {
        const data = JSON.parse(event.data);

        if (Object.prototype.hasOwnProperty.call(data, 'callbackID')) {
            const callbackID = data['callbackID'];
            const callback = this.callbacks[callbackID];
            if (typeof callback === 'function') {
                const removeCallback = callback(data);
                if (removeCallback) {
                    delete this.callbacks[callbackID];
                }
            } else {
                console.log('[TCP] Callback not found:', callbackID);
            }
        }
    };

    onError = (event: Event) => {
        console.log('[TCP] TCP server:', event);
        this.state = 'error';
    };

    onClose = (event: CloseEvent) => {
        void event;
        this.state = 'disconnected';
        this.Disconnect();
        this.callbackClose();
    };

    Send = (action: keyof RequestClientToServer, content: RequestClientToServer[typeof action], callbackID?: string): boolean => {
        if (typeof content !== 'object') {
            console.log('[TCP] Send socket: Invalid message type.');
            return false;
        }

        if (this.socket === null || !this.IsConnected()) {
            console.log('[TCP] Send socket: Not connected.');
            return false;
        }

        const data = { action, callbackID, content };
        this.socket.send(JSON.stringify(data));
        return true;
    };

    SendAsync = async (action: keyof RequestClientToServer, data: RequestClientToServer[typeof action], timeout = 10000): Promise<'not-sended' | 'timeout' | RequestServerToClient[typeof action]> => {
        const callbackID = action + '-' + Math.random().toString(36).substring(7);
        const sended = this.Send(action, data, callbackID);

        if (sended === false) {
            return Promise.resolve('not-sended');
        }

        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                resolve('timeout');
            }, timeout);
            this.callbacks[callbackID] = (data) => {
                clearTimeout(timer);
                resolve(data['content']);
                return true;
            };
        });
    };
}

const tcp = new ClientTCP();

export { tcp };
export default ClientTCP;
