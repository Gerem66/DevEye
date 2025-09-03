import path from 'path';
import Server from '@/Server';
import SQL from '@/Services/SQL';
import Encryption from '@/Services/Encryption';
import { createPool } from 'mysql2/promise';

import GLogs from '@/Utils/Logs';
import { env } from '@/Utils/Env';
import { Features } from '@/Features';
import { userManager } from '@/Services/UserManager';

import type { TCPRequestReceiveHeader } from 'deveye-types';
import { InitializeGameLifeDB } from '@/Features/GameLife/gamelife-set-loop';

const logsDir = path.join(env.LOG_PATH, env.ENVIRONMENT);
GLogs.OpenLogs(env.LOG_LEVEL, logsDir, env.LOG_KEEP_DAYS);

const db = new SQL({
    name: 'DB-DevEye',
    pool: createPool({
        database: env.DB_DATABASE || '',
        host: env.DB_HOSTNAME || '',
        user: env.DB_USERNAME || '',
        password: env.DB_PASSWORD || '',
        port: env.DB_PORT
    })
});

InitializeGameLifeDB();

const crypt = new Encryption(env.CRYPT_KEY_A, env.CRYPT_KEY_B);

const serv = new Server();

serv.Listen(8888, {
    onConnect: () => {
        GLogs.info('[DevEye] User connected');
    },

    onDisconnect: (_connection, profile) => {
        GLogs.info('[DevEye] User disconnected');
        if (profile?.user) {
            userManager.remove(profile.user.ID);
        }
    },

    onError: (_connection, profile, error) => {
        GLogs.error(`[DevEye] Connection error:' ${error.message}`);
        if (profile.user !== null) {
            userManager.remove(profile.user.ID);
        }
    },

    onMessage: async (connection, profile, data) => {
        if (typeof data.action !== 'string') {
            GLogs.warn(`[DevEye] Invalid action type: ${typeof data.action}`);
            return;
        }

        const feature = Features[data.action];
        if (!feature) {
            // TODO: Log
            GLogs.warn(`[DevEye] Feature not implemented: ${data.action}`);
            return;
        }

        const response: TCPRequestReceiveHeader<typeof data.action> = {
            action: data.action,
            content: { status: 1, message: 'Feature not implemented' },
            callbackID: data.callbackID
        };

        try {
            // TODO: Wring data content type ? :thinking:
            response.content = await feature({ db, crypt, profile, data: data.content });
        } catch (error) {
            GLogs.error(`[DevEye] Error processing feature ${data.action}: ${(error as Error).message}`);
            response.content = { status: 500, message: 'Internal server error' };
        }

        connection.send(JSON.stringify(response));
    }
});
