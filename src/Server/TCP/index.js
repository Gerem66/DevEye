import 'dotenv/config';

import SQL from './src/SQL.js';
import Server from './src/Server.js';
import Encryption from './src/Utils/Encryption.js';

import { GetUserInfo } from './src/Features/getUserInfo.js';
import { GetPassword, GetPasswords } from './src/Features/getPassword.js';

const database = new SQL({
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
        if (data.action === 'get-user-info') {
            const response = await GetUserInfo(database, data);
            connection.send(JSON.stringify(response));
        }

        else if (data.action === 'get-passwords') {
            const response = await GetPasswords(database, crypt, data);
            connection.send(JSON.stringify(response));
        }

        else if (data.action === 'get-password') {
            const response = await GetPassword(database, crypt, data);
            connection.send(JSON.stringify(response));
        }
    }
});
