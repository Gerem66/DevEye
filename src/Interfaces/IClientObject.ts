import WebSocket from 'websocket';

export type SendTCPLogData = 'all' | 'reduce' | 'none';

export interface IClientObject {
    connection: WebSocket.connection;
    isTrusted: boolean;

    // TODO: Define object structure
    SendTCP: (data: object, logData?: SendTCPLogData) => void;
    Close: (code: number, reason?: string) => void;
}
