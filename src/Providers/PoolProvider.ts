import { injectable } from 'inversify';
import { createPool, Pool } from 'mysql2/promise';

import { IPool } from '@/Interfaces/IPool';
import { env } from '@/Utils/Env';

@injectable()
export default class PoolProvider implements IPool {
    name = 'SQL';
    pool: Pool;

    constructor() {
        this.pool = createPool({
            host: env.DB_HOSTNAME,
            port: env.DB_PORT,
            database: env.DB_DATABASE,
            user: env.DB_USERNAME,
            password: env.DB_PASSWORD,
            enableKeepAlive: true,
            waitForConnections: true,
            connectionLimit: 10,
            queueLimit: 0,
            idleTimeout: 30000
        });
    }
}
