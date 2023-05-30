import Server from './src/server.js';

const serv = new Server();

serv.onConnect = (connection) => {
    console.log('User connected');

    connection.on('message', async (message) => {
        console.log('Data:', message.utf8Data);
        connection.send('hey!');
    });

    connection.on('close', () => {
        console.log('User disconnected');
    });

    connection.on('error', (err) => {
        console.error('Connection error:', err);
    });
}

serv.Listen(8080);