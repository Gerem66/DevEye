import 'dotenv/config';

import SQL from './src/SQL.js';
import Server from './src/Server.js';
import Encryption from './src/Utils/Encryption.js';

import { Login } from './src/Features/getUserInfo.js';
import { CheckPassword } from './src/Features/checkPassword.js';
import { GetPassword, GetPasswords } from './src/Features/getPassword.js';
import { AddPassword, EditPassword, DeletePassword } from './src/Features/setPassword.js';
import { AddContext } from './src/Features/addContext.js';

/**
 * @typedef {import('./src/Server.js').ProfileType} ProfileType
 */

const db = new SQL({
    database: process.env.DB_DATABASE || '',
    hostname: process.env.DB_HOSTNAME || '',
    username: process.env.DB_USERNAME || '',
    password: process.env.DB_PASSWORD || ''
});

const keyA = process.env.DB_KEY_A || '';
const keyB = process.env.DB_KEY_B || '';

/** @type {Object<string, ProfileType>} */
const users = {};

const crypt = new Encryption(keyA, keyB);
const serv = new Server();
serv.Listen(8080, {
    onConnect: (connection, profile) => {
        console.log('User connected');
    },

    onDisconnect: (connection, profile) => {
        console.log('User disconnected');
        if (!!profile?.user) {
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
        let response = null;
        switch (data.action) {
            case 'login':
                response = await Login(db, data);
                if (response.content.status === 0 && response.content.user !== null) {
                    profile.user = response.content.user;
                    profile.firstMessage = false;
                    users[`${profile.user.ID}`] = profile;
                }
                break;

            case 'check-password':  response = CheckPassword(db, data);                 break;
            case 'get-passwords':   response = GetPasswords(db, crypt, data);           break;
            case 'get-password':    response = GetPassword(db, crypt, data);            break;
            case 'add-password':    response = AddPassword(db, crypt, data);            break;
            case 'edit-password':   response = EditPassword(db, crypt, data);           break;
            case 'delete-password': response = DeletePassword(db, data);                break;
            case 'add-context':     response = AddContext(db, crypt, profile, data);    break;
        }

        if (response !== null) {
            connection.send(JSON.stringify(await response));
        }
    }
});
