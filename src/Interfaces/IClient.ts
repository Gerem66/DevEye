import WebSocket from 'websocket';

import type { UserType } from 'deveye-types';

export interface ClientSession {
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
