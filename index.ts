import 'dotenv/config';

import SQL from './src/SQL.js';
import Server from './src/Server.js';
import Encryption from './src/Utils/Encryption.js';

import { Login, SetFavorite } from './src/Features/getUserInfo.js';
import { CheckPassword } from './src/Features/checkPassword.js';
import { GetPassword, GetPasswords } from './src/Features/getPassword.js';
import { AddPassword, EditPassword, DeletePassword } from './src/Features/addPassword.js';
import { AddContext, DeleteContext } from './src/Features/addContext.js';
import { Unlock } from './src/Features/unlock.js';
import { GetGameLifeData } from './src/Features/gamelife.js';

type RequestTypes = import('./src/Features/types.js').RequestTypes;

type ProfileType = import('./src/Server.js').ProfileType;

type TCPFeatureType<T extends RequestTypes> = import('./src/Features/types.js').TCPFeatureType<T>;

type TCPRequestReceiveHeader<T extends RequestTypes> = import('./src/Features/types.js').TCPRequestReceiveHeader<T>;

const db = new SQL({
    database: process.env.DB_DATABASE || '',
    hostname: process.env.DB_HOSTNAME || '',
    username: process.env.DB_USERNAME || '',
    password: process.env.DB_PASSWORD || '',
    port: parseInt(process.env.DB_PORT || '3306')
});

console.log('SQL Pool created', {
    database: process.env.DB_DATABASE,
    hostname: process.env.DB_HOSTNAME,
    username: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD,
    port: parseInt(process.env.DB_PORT || '3306')
});

const keyA = process.env.DB_KEY_A || '';
const keyB = process.env.DB_KEY_B || '';

const users: { [key: string]: ProfileType } = {};

const crypt = new Encryption(keyA, keyB);
const serv = new Server();

serv.Listen(8888, {
    onConnect: () => {
        console.log('User connected');
    },

    onDisconnect: (connection, profile) => {
        console.log('User disconnected');
        if (profile?.user) {
            delete users[`${profile.user.ID}`];
        }
    },

    onError: (connection, profile, error) => {
        console.error('Connection error:', error);
        if (profile.user !== null) {
            delete users[`${profile.user.ID}`];
        }
    },

    onMessage: async (connection, profile, data) => {
        let action: TCPFeatureType<RequestTypes> | null = null;
        let result: TCPRequestReceiveHeader<RequestTypes>['content'] | null = null;

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
            const response: TCPRequestReceiveHeader<RequestTypes> = {
                action: data.action,
                content: result,
                callbackID: data.callbackID
            };
            connection.send(JSON.stringify(response));
        }
    }
});
