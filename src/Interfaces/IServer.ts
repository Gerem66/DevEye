import { Server as ServerHTTP } from 'http';
import { Server as ServerHTTPS } from 'https';

export interface IServer {
    server: ServerHTTP | ServerHTTPS;
}
