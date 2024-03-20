import 'dotenv/config';
import SQL from './src/SQL.js';
import Server from './src/Server.js';
import MyCrypto from './src/Utils/Crypt.js';
import { ffetch } from './src/Utils/Request.js';

/**
 * @typedef {import('Types/TCP.ts').TCPRequestMap} TCPRequestMap
 * @typedef {import('Types/TCP.ts').TCPRequestHeader} TCPRequestHeader
 * @typedef {import('Types/TCP.ts').ReceiveRequestGetUserInfo} ReceiveRequestGetUserInfo
 */

const database = new SQL({
    database: process.env.DB_DATABASE || '',
    hostname: process.env.DB_HOSTNAME || '',
    username: process.env.DB_USERNAME || '',
    password: process.env.DB_PASSWORD || ''
});

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
            const message = /** @type {TCPRequestMap['get-user-info']['send']} */ (data.message);

            // Check token & code
            const code = 'UJu-79a?:w=4O7mp#sM]yQiOsI/Jb_ag';
            const token = message.token;
            const requestToken = await ffetch('get-token', { code, token });
            if (requestToken.status !== 0) {
                // TODO: Alert
                connection.send(JSON.stringify({
                    status: 1,
                    callbackID: data.callbackID
                }));
                return;
            }

            const user = await database.QueryPrepare('SELECT * FROM Users WHERE Token = ?', [requestToken.content]);
            if (user === null) {
                // TODO: Alert
                connection.send(JSON.stringify({
                    status: 1,
                    callbackID: data.callbackID
                }));
            }

            // Load contexts
            const selfContext = {
                id: 'self',
                name: user[0].Username,
                logo: user[0].Avatar,
                features: [
                    'dashboard',
                    'password'
                ]
            };
            const tempContexts = [
                {
                    id: 'test',
                    name: 'test',
                    logo: 'default.png',
                    features: [
                        'dashboard'
                    ]
                }
            ];
            user[0].Contexts = [selfContext, ...tempContexts];

            /** @type {TCPRequestHeader} */
            const response = {
                action: 'get-user-info',
                /** @type {ReceiveRequestGetUserInfo} */
                message: {
                    status: 0,
                    user: user[0]
                },
                callbackID: data.callbackID
            };

            connection.send(JSON.stringify(response));
        }
    }
});
