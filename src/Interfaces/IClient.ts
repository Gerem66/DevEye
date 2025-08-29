import WebSocket from 'websocket';
import { IClientObject } from './IClientObject';

export interface IClientStatic {
    protocols: string[];
}

export interface IClient<C extends IClientObject, TCPTypes = object> {
    clientType: C;

    /** @description On connecting, before storing in server's clients & returning client data */
    onConnect: (connection: WebSocket.connection) => Promise<C>;

    onConnected?: (client: C) => void;

    onDisconnect: (client: C, code: number, description: string) => void;

    onMessage: <M extends TCPTypes>(client: C, data: M) => void;

    onError: (client: C, error: Error) => void;
}
