import Server from '@/Server';
import SQL from '@/Services/SQL';
import Encryption from '@/Services/Encryption';
import { createPool } from 'mysql2/promise';

import { env } from '@/Utils/Env';
import { Features } from '@/Features';
import { userManager } from '@/Services/UserManager';

import type { TCPRequestReceiveHeader } from 'deveye-types';

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

const crypt = new Encryption(env.CRYPT_KEY_A, env.CRYPT_KEY_B);

const serv = new Server();

serv.Listen(8888, {
    onConnect: () => {
        console.log('User connected');
    },

    onDisconnect: (_connection, profile) => {
        console.log('User disconnected');
        if (profile?.user) {
            userManager.remove(profile.user.ID);
        }
    },

    onError: (_connection, profile, error) => {
        console.error('Connection error:', error);
        if (profile.user !== null) {
            userManager.remove(profile.user.ID);
        }
    },

    onMessage: async (connection, profile, data) => {
        if (typeof data.action !== 'string') {
            console.warn('Invalid action type:', typeof data.action);
            return;
        }

        const feature = Features[data.action];
        if (!feature) {
            // TODO: Log
            console.warn(`Feature not implemented: ${data.action}`);
            return;
        }

        // TODO: Wring data content type ? :thinking:
        const result = await feature({ db, crypt, profile, data: data.content });

        const response: TCPRequestReceiveHeader<typeof data.action> = {
            action: data.action,
            content: result,
            callbackID: data.callbackID
        };
        connection.send(JSON.stringify(response));
    }
});
