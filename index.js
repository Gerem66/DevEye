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

/**
 * @typedef {import('./src/Features/types.js').RequestTypes} RequestTypes
 * @typedef {import('./src/Server.js').ProfileType} ProfileType
 */

/**
 * @template {RequestTypes} T
 * @typedef {import('./src/Features/types.js').TCPFeatureType<T>} TCPFeatureType
 */

/**
 * @template {RequestTypes} T
 * @typedef {import('./src/Features/types.js').TCPRequestReceiveHeader<T>} TCPRequestReceiveHeader
 */

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

/** @type {Object<string, ProfileType>} */
const users = {};

const crypt = new Encryption(keyA, keyB);
const serv = new Server();
serv.Listen(8888, {
    onConnect: () => {
        console.log('User connected');
        // const A = crypt.Decrypt(
        //     '3kWB4ocUrcV9rMKjwpTa4+m1PGlF2AdKhdPmubCTq+6MLCFih9+lzhuFLKxt+6zb8fhaKgyHdvoGxmkG4zkdoLyRATiazvp/I7EXz/ZW5AAKKthc69dLIxcrTfrewjc4E/0pe61pQ4Q2FVk6UuLaXEQ1dETP6297YhShsCsb2frym0iSaGZf1/mpetaYvBirtR9407o6g6rivPurGj5rGK20i4VoJyUnv9tKc/qWsjQnf8Vj0AaqoHDd7NVo5RBZff4CtbP8dZZyRGFjMYkdaw47fUIK05EohL4idIYNmVqVRDJ6hSCmewXrKQUBatqgmWN0s+C2+nmm+F2PCYYGa4wF/QN87opJimlFzSbqlqaTG4PGdrMDGAwTB7IHV/c9KOCOeleZaoB8PEPy6FvMkN5crSwlKoH2Zop6h9itMuOHdQSOiFNxgdrKD/oJTeeZ2bsNT/RpLkkXs0hyecBUyy+oPVQVLfXjLYIKeAvB'
        // );
        // console.log(A);
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
        /** @type {TCPFeatureType<*> | null} */
        let action = null;

        /** @type {TCPRequestReceiveHeader<*>['content'] | null} */
        let result = null;

        switch (/** @type {RequestTypes} */ data.action) {
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
            /** @type {TCPRequestReceiveHeader<*>} */
            const response = {
                action: data.action,
                content: result,
                callbackID: data.callbackID
            };
            connection.send(JSON.stringify(response));
        }
    }
});
