import WebSocket from 'websocket';

import type { DBType_User } from 'deveye-types';

export interface ClientSession {
    user: DBType_User | null;
    connection: WebSocket.connection;
    firstMessage: boolean;
    authentifications: Array<{
        workspaceID: number;
        clearPassword: string;
        passwordResetTime: number;
        resetTimeout: NodeJS.Timeout | null;
    }>;
}
