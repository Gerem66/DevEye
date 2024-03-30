import 'dotenv/config';
import SQL from './src/SQL.js';
import Server from './src/Server.js';
import Encryption from './src/Utils/Encryption.js';
import { ffetch } from './src/Utils/Request.js';
import { StrIsJson } from './src/Utils/Functions.js';

/**
 * @typedef {import('Types/TCP.js').SendRequestType} SendRequestType
 * @typedef {import('Types/TCP.js').ReceiveRequestType} ReceiveRequestType
 * @typedef {import('Types/Password.js').PasswordType} PasswordType
 * @typedef {import('Types/Password.js').PasswordDatabaseType} PasswordDatabaseType
 */

/**
 * @template {keyof ReceiveRequestType} T
 * @typedef {import('Types/TCP.js').TCPRequestHeader<T>} TCPRequestHeader
 */

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
            const message = /** @type {SendRequestType['get-user-info']} */ (data.message);

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

            // Update LastLogin
            database.QueryPrepare('UPDATE Users SET LastLogin = NOW() WHERE ID = ?', [ user[0].ID ]);

            user[0].LastLogin = (new Date(user[0].LastLogin)).getTime() / 1000;
            user[0].Created = (new Date(user[0].Created)).getTime() / 1000;

            // Load contexts
            /** @type {Array<{ ContextID: number }>} */
            const rawContextsID = await database.QueryPrepare('SELECT `ContextID` FROM ContextsLinks WHERE UserID = ?', [ user[0].ID ]);
            if (rawContextsID === null) {
                connection.send(JSON.stringify({
                    status: 1,
                    callbackID: data.callbackID
                }));
            }

            const contextsID = rawContextsID.map((c) => c.ContextID);
            /** @type {Array<{ ID: number, Name: string, Logo: string, Features: string }>} */
            const contexts = await database.QueryPrepare('SELECT * FROM Contexts WHERE ID IN (?)', [ contextsID.join(',') ]);
            if (contexts === null) {
                connection.send(JSON.stringify({
                    status: 1,
                    callbackID: data.callbackID
                }));
            }

            const selfContext = {
                id: 0,
                name: user[0].Username,
                logo: user[0].Avatar,
                features: JSON.parse(user[0].Features)
            };
            const userContexts = contexts.map((c) => {
                return {
                    id: c.ID,
                    name: c.Name,
                    logo: c.Logo,
                    features: JSON.parse(c.Features)
                };
            });
            user[0].Contexts = [selfContext, ...userContexts];

            /** @type {TCPRequestHeader<'get-user-info'>} */
            const response = {
                action: 'get-user-info',
                /** @type {ReceiveRequestType['get-user-info']} */
                message: {
                    status: 0,
                    user: user[0]
                },
                callbackID: data.callbackID
            };

            connection.send(JSON.stringify(response));
        }

        else if (data.action === 'get-passwords') {
            const message = /** @type {SendRequestType['get-passwords']} */ (data.message);

            /** @type {Array<PasswordDatabaseType>} */
            const passwords = await database.QueryPrepare('SELECT * FROM _Passwords WHERE UserID = ?', [ message.userID ]);
            if (passwords === null) {
            }

            const passwordsFormatted = passwords.map(/** @returns {PasswordType | null} */ (p) => {
                const rawContent = crypt.Decrypt(p.Content);
                if (!rawContent || !StrIsJson(rawContent)) {
                    console.log('Error: Password content is not valid', rawContent);
                    return null;
                }

                const content = JSON.parse(rawContent);
                if (!content.hasOwnProperty('service') || !content.hasOwnProperty('category') || !content.hasOwnProperty('email') || !content.hasOwnProperty('password') || !content.hasOwnProperty('status')) {
                    console.log('Error: Password content is not valid2', content);
                    return null;
                }

                const ID = p.ID;
                const { category, service, email, password: realPassword, status } = content;
                const password = !!realPassword ? '**********' : '';
                return { ID, category, service, email, password, status };
            })
            .filter((p) => p !== null);

            /** @type {TCPRequestHeader<'get-passwords'>} */
            const response = {
                action: 'get-passwords',
                /** @type {ReceiveRequestType['get-passwords']} */
                message: {
                    status: 0,
                    passwords: passwordsFormatted
                },
                callbackID: data.callbackID
            };

            connection.send(JSON.stringify(response));
        }

        else if (data.action === 'get-password') {
            const message = /** @type {SendRequestType['get-password']} */ (data.message);

            /** @type {Array<PasswordDatabaseType>} */
            const resultPassword = await database.QueryPrepare('SELECT * FROM _Passwords WHERE UserID = ? AND ID = ?', [ message.userID, message.passwordID ]);
            if (resultPassword === null || resultPassword.length === 0) {
                console.log('Error: Password not found');
                return;
            }

            const rawContent = crypt.Decrypt(resultPassword[0].Content);
            if (!rawContent || !StrIsJson(rawContent)) {
                console.log('Error: Password content is not valid', rawContent);
                return;
            }

            const content = JSON.parse(rawContent);
            if (!content.hasOwnProperty('service') || !content.hasOwnProperty('category') || !content.hasOwnProperty('email') || !content.hasOwnProperty('password') || !content.hasOwnProperty('status')) {
                console.log('Error: Password content is not valid2', content);
                return;
            }

            const ID = resultPassword[0].ID;
            const { category, service, email, password, status } = content;

            /** @type {TCPRequestHeader<'get-password'>} */
            const response = {
                action: 'get-password',
                /** @type {ReceiveRequestType['get-password']} */
                message: {
                    status: 0,
                    password: { ID, category, service, email, password, status }
                },
                callbackID: data.callbackID
            };

            connection.send(JSON.stringify(response));
        }
    }
});
