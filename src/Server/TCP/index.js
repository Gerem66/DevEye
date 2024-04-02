import 'dotenv/config';

import SQL from './src/SQL.js';
import Server from './src/Server.js';
import Encryption from './src/Utils/Encryption.js';

import { GetUserInfo } from './src/Features/getUserInfo.js';
import { CheckPassword } from './src/Features/checkPassword.js';
import { GetPassword, GetPasswords } from './src/Features/getPassword.js';
import { AddPassword, EditPassword, DeletePassword } from './src/Features/setPassword.js';

const db = new SQL({
    database: process.env.DB_DATABASE || '',
    hostname: process.env.DB_HOSTNAME || '',
    username: process.env.DB_USERNAME || '',
    password: process.env.DB_PASSWORD || ''
});

const keyA = process.env.DB_KEY_A || '';
const keyB = process.env.DB_KEY_B || '';

const crypt = new Encryption(keyA, keyB);
const serv = new Server();
serv.Listen(8080, {
    onConnect: (connection) => {
        console.log('User connected');
    },

    onDisconnect: (connection) => {
        console.log('User disconnected');
    },

    onError: (connection, error) => {
        console.error('Connection error:', error);
    },

    onMessage: async (connection, data) => {
        let response = null;
        switch (data.action) {
            case 'get-user-info':   response = GetUserInfo(db, data);           break;
            case 'check-password':  response = CheckPassword(db, data);         break;
            case 'get-passwords':   response = GetPasswords(db, crypt, data);   break;
            case 'get-password':    response = GetPassword(db, crypt, data);    break;
            case 'add-password':    response = AddPassword(db, crypt, data);    break
            case 'edit-password':   response = EditPassword(db, crypt, data);   break;
            case 'delete-password': response = DeletePassword(db, data);        break;
        }

        if (response !== null) {
            connection.send(JSON.stringify(await response));
        }
    }
});
