import Server from '@/Server';
import SQL from '@/Services/SQL';
import Encryption from '@/Services/Encryption';
import { createPool } from 'mysql2/promise';

import { Login, SetFavorite } from '@/Features/getUserInfo';
import { CheckPassword } from '@/Features/checkPassword';
import { GetPassword, GetPasswords } from '@/Features/getPassword';
import { AddPassword, EditPassword, DeletePassword } from '@/Features/addPassword';
import { AddContext, DeleteContext } from '@/Features/addContext';
import { Unlock } from '@/Features/unlock';
import { GetGameLifeData } from '@/Features/gamelife';
import { env } from '@/Utils/Env';

import type { RequestCommands, TCPRequestReceiveHeader } from 'deveye-types';
import type { ProfileType } from '@/Server';
import type { TCPFeatureType } from '@/Features/types';

const db = new SQL({
    name: 'MainDatabase',
    pool: createPool({
        database: env.DB_DATABASE || '',
        host: env.DB_HOSTNAME || '',
        user: env.DB_USERNAME || '',
        password: env.DB_PASSWORD || '',
        port: env.DB_PORT
    })
});

console.log('SQL Pool created', {
    database: env.DB_DATABASE,
    hostname: env.DB_HOSTNAME,
    username: env.DB_USERNAME,
    password: env.DB_PASSWORD,
    port: env.DB_PORT
});

const users: { [key: string]: ProfileType } = {};

const crypt = new Encryption(env.CRYPT_KEY_A, env.CRYPT_KEY_B);
const serv = new Server();

serv.Listen(8888, {
    onConnect: () => {
        console.log('User connected');
    },

    onDisconnect: (_connection, profile) => {
        console.log('User disconnected');
        if (profile?.user) {
            delete users[`${profile.user.ID}`];
        }
    },

    onError: (_connection, profile, error) => {
        console.error('Connection error:', error);
        if (profile.user !== null) {
            delete users[`${profile.user.ID}`];
        }
    },

    onMessage: async (connection, profile, data) => {
        let action: TCPFeatureType<keyof RequestCommands> | null = null;
        let result: TCPRequestReceiveHeader<keyof RequestCommands>['content'] | null = null;

        switch (data.action) {
            case 'login': {
                console.log('User login');
                const resultLogin = await Login({ db, crypt, profile, data: data.content });
                console.log('User login =>', resultLogin);
                if (resultLogin.status === 0 && resultLogin.user !== null) {
                    profile.user = resultLogin.user;
                    profile.firstMessage = false;
                    users[`${profile.user.ID}`] = profile;
                    if (data.content.password) {
                        await Unlock(db, profile, 0, data.content.password);
                    }
                    result = resultLogin;
                }
                break;
            }
            case 'check-password':
                action = CheckPassword;
                break;
            case 'get-passwords':
                action = GetPasswords;
                break;
            case 'get-password':
                action = GetPassword;
                break;
            case 'add-password':
                action = AddPassword;
                break;
            case 'edit-password':
                action = EditPassword;
                break;
            case 'delete-password':
                action = DeletePassword;
                break;
            case 'add-context':
                action = AddContext;
                break;
            case 'delete-context':
                action = DeleteContext;
                break;
            case 'change-favorite-context':
                action = SetFavorite;
                break;
            case 'gamelife-set-loop':
                action = GetGameLifeData;
                break;
        }

        if (action !== null) {
            result = await action({ db, crypt, profile, data: data.content });
        }

        if (result !== null) {
            const response: TCPRequestReceiveHeader<keyof RequestCommands> = {
                action: data.action,
                content: result,
                callbackID: data.callbackID
            };
            connection.send(JSON.stringify(response));
        }
    }
});
