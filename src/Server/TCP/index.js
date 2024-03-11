import 'dotenv/config';
import SQL from './src/SQL.js';
import Server from './src/Server.js';

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

    onMessage: (connection, data) => {
        console.log('User message:', data);
    }
});
