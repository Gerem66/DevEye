import { Pool, PoolConnection, QueryResult, RowDataPacket, QueryError } from 'mysql2/promise';

import { SerializeError } from '@/Utils/Types';
import type { IPool } from '@/Interfaces/IPool';

import GLogs from '@/Utils/Logs';
import { env } from '@/Utils/Env';

export interface ChecksumType {
    Table: string;
    Checksum: number;
}

export default class SQL {
    #providerName: string;
    #pool: Pool | undefined;
    connected: boolean = false;

    constructor(provider: IPool) {
        this.#providerName = provider.name;
        this.#pool = provider.pool;

        if (!this.#pool) {
            GLogs.debug(`[${this.#providerName}] Pool not initialized`);
            return;
        }

        GLogs.debug(`[${this.#providerName}] Pool created`);
        this.connected = true;

        this.#pool.on('connection', (connection: PoolConnection) => {
            if (env.LOG_LEVEL === 'all') {
                GLogs.debug(`[${this.#providerName}] Pool Connection established`, { threadId: connection.threadId });
            }
        });

        this.#pool.on('acquire', (connection: PoolConnection) => {
            if (env.LOG_LEVEL === 'all') {
                GLogs.debug(`[${this.#providerName}] Pool Connection acquired`, { threadId: connection.threadId });
            }
        });

        this.#pool.on('enqueue', () => {
            if (env.LOG_LEVEL === 'all') {
                GLogs.debug(`[${this.#providerName}] Waiting for available connection slot`);
            }
        });

        this.#pool.on('release', (connection: PoolConnection) => {
            if (env.LOG_LEVEL === 'all') {
                GLogs.debug(`[${this.#providerName}] Pool Connection released`, { threadId: connection.threadId });
            }
        });
    }

    Disconnect = async (): Promise<void> => {
        if (!this.#pool) {
            GLogs.warn(`${this.#providerName} Pool not initialized`);
            return;
        }

        try {
            await this.#pool.end();
            this.#pool = undefined;
            this.connected = false;
            GLogs.debug(`[${this.#providerName}] Pool closed`);
        } catch {
            GLogs.warn(`[${this.#providerName}] Error: Pool is probably already closed`);
        }
    };

    /**
     * Test the connection to the database by executing a simple query.
     * @returns A promise that resolves if the connection is successful, otherwise rejects with an error.
     */
    TestConnection = async (): Promise<boolean> => {
        if (!this.#pool) {
            return false;
        }

        try {
            await this.ExecQuery('SELECT 1');
            this.connected = true;
            GLogs.info(`[${this.#providerName}] Connected to ${env.DB_HOSTNAME}:${env.DB_PORT}/${env.DB_DATABASE}`);
            return true;
        } catch (error) {
            this.connected = false;
            GLogs.error(`[${this.#providerName}] Connection failed: ${JSON.stringify((error as QueryError).code)}`, {
                error: SerializeError(error)
            });
            return false;
        }
    };

    ExecQuery = async <T = QueryResult>(query: string): Promise<T> => {
        if (!this.#pool) {
            throw new Error('SQL Pool not initialized');
        }

        const timeStart = Date.now();
        try {
            const [rows] = await this.#pool.query<RowDataPacket[]>(query);
            const timeEnd = Date.now();
            if (env.LOG_LEVEL === 'all') {
                GLogs.debug(`[${this.#providerName}] Query (${query}) took ${timeEnd - timeStart}ms`);
            }
            return rows as T;
        } catch (err) {
            GLogs.warn(`[${this.#providerName}] Query (${query}) Error`, { err });
            throw err;
        }
    };

    QueryPrepare = async <T = QueryResult>(command: string, args: (string | number | null)[]): Promise<T> => {
        if (!this.#pool) {
            throw new Error(`[${this.#providerName}] Pool not initialized`);
        }

        try {
            const [rows] = await this.#pool.execute<RowDataPacket[]>(command, args);
            return rows as T;
        } catch (err) {
            GLogs.warn(`[${this.#providerName}] Query Error => ${command} <=`, { err });
            throw err;
        }
    };

    /** @example BulkInsert('INSERT INTO table (column1, column2) VALUES ?', [[1, 2], [3, 4], [5, 6]]); */
    BulkInsert = async <T = QueryResult>(command: string, values: (string | number | null)[][]): Promise<T> => {
        if (!this.#pool) {
            throw new Error('SQL Pool not initialized');
        }

        try {
            const [rows] = await this.#pool.query<RowDataPacket[]>(command, [values]);
            return rows as T;
        } catch (err) {
            GLogs.warn(`[${this.#providerName}] Bulk Insert Error => ${command} <=`, { err });
            throw err;
        }
    };

    async GetTableHash(tableName: string): Promise<ChecksumType | null> {
        try {
            const rows = await this.ExecQuery<ChecksumType[]>(`CHECKSUM TABLE ${tableName}`);
            if (rows.length !== 1) {
                return null;
            }
            return rows[0];
        } catch {
            GLogs.error(`[${this.#providerName}.GetTableHash/${tableName}] Failed to get table hash`);
            return null;
        }
    }
}
