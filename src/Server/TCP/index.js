import 'dotenv/config';
import SQL from './src/SQL.js';
import Server from './src/Server.js';
import MyCrypto from './src/Utils/Crypt.js';

/**
 * @typedef {import('Types/TCP.ts').TCPRequestMap} TCPRequestMap
 */

const database = new SQL({
    database: process.env.DB_DATABASE,
    hostname: process.env.DB_HOSTNAME,
    username: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD
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
            //const user = database.QueryPrepare('SELECT * FROM users WHERE token = ?', [message.token]);
            //connection.send(JSON.stringify({ status: 200, user }));
            const token = message.token;
            const a = new MyCrypto('!VjrqHB_eQ?r#C8HBj1<470L:Ddd;jO$', 'Y0QuZLpVt38Qb?Fai4Hy@$Ix#iG8J1nw');
            const decrypted = await a.decrypt(message.token);
            console.log(decrypted);
            connection.send(JSON.stringify({ status: 200, user: 'aaaaaaa' }));
        }
    }
});
