import fs from 'fs';
import { injectable } from 'inversify';
import { createServer as createHTTP, Server as ServerHTTP } from 'http';
import { createServer as createHTTPS, Server as ServerHTTPS } from 'https';

import { IServer } from '@/Interfaces/IServer';
import { env } from '@/Utils/Env';
import GLogs from '@/Utils/Logs';
import { SerializeError } from '@/Utils/Types';

@injectable()
export default class ServerProvider implements IServer {
    server: ServerHTTP | ServerHTTPS;

    constructor() {
        if (typeof env.SSL_CERTIFICATE_PATH === 'undefined' || typeof env.SSL_PRIVATE_KEY_PATH === 'undefined') {
            this.server = createHTTP({});
            GLogs.warn('[Server] Running without SSL');
        } else {
            try {
                this.server = createHTTPS({
                    key: fs.readFileSync(env.SSL_PRIVATE_KEY_PATH),
                    cert: fs.readFileSync(env.SSL_CERTIFICATE_PATH)
                });
                GLogs.info('[Server] SSL Certificates loaded successfully');
            } catch (error) {
                this.server = createHTTP({});
                GLogs.error('[Server] SSL Certificates failed, use unsecure connection', {
                    error: SerializeError(error)
                });
            }
        }
    }
}
