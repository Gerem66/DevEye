import mysql, {
    type Connection,
    type ConnectionOptions,
    type Pool,
    type PoolConnection,
    type PoolOptions,
    type ResultSetHeader,
    type RowDataPacket
} from 'mysql2/promise';

import { env } from '@/Utils/Env';
import { logger } from '@/logger';

export type DbPool = Pool;

/**
 * Normalized query result so repositories keep using `.rows`, `.rowCount`
 * and `.insertId` regardless of the underlying mysql2 return shape.
 */
export interface QueryResultLike<T> {
    rows: T[];
    rowCount: number;
    insertId: number;
}

/** Minimal query surface shared by the pool and a transaction connection. */
export interface Queryable {
    query<T = RowDataPacket>(sql: string, params?: unknown[]): Promise<QueryResultLike<T>>;
}

type RawQueryable = Pick<Pool, 'query'> | Pick<PoolConnection, 'query'> | Pick<Connection, 'query'>;

function wrap(conn: RawQueryable): Queryable {
    return {
        async query<T>(sql: string, params?: unknown[]): Promise<QueryResultLike<T>> {
            const [result] = await conn.query(sql, params);
            if (Array.isArray(result)) {
                return { rows: result as T[], rowCount: result.length, insertId: 0 };
            }
            const header = result as ResultSetHeader;
            return {
                rows: [],
                rowCount: header.affectedRows ?? 0,
                insertId: header.insertId ?? 0
            };
        }
    };
}

type ConnectionError = Error & {
    code?: string;
    errno?: string | number;
    syscall?: string;
    address?: string;
    port?: number;
    sqlState?: string;
    errors?: unknown[];
};

function serializeConnectionError(err: unknown): Record<string, unknown> {
    const e = err as ConnectionError;
    return {
        name: e.name,
        message: e.message,
        code: e.code,
        errno: e.errno,
        syscall: e.syscall,
        address: e.address,
        port: e.port,
        sqlState: e.sqlState,
        errors: e.errors?.map((item) => serializeConnectionError(item))
    };
}

/** La base visée par l'environnement, commune au pool et aux connexions ponctuelles. */
function connectionOptions(): ConnectionOptions {
    return {
        host: env.DB_HOSTNAME,
        port: env.DB_PORT,
        database: env.DB_DATABASE,
        user: env.DB_USERNAME,
        password: env.DB_PASSWORD
    };
}

export function createDbPool(): DbPool {
    const config: PoolOptions = {
        ...connectionOptions(),
        connectionLimit: env.DB_POOL_MAX,
        waitForConnections: true,
        enableKeepAlive: true
    };

    return mysql.createPool(config);
}

/**
 * Une connexion éphémère qui accepte un fichier `.sql` entier en une requête
 * (les migrations, l'`uninstall.sql` d'un module). Elle seule est en
 * `multipleStatements` : le pool qui sert les requêtes ne sait pas empiler,
 * pour qu'une injection y reste cantonnée à la requête où elle naît.
 */
export async function withSqlFileConnection<T>(fn: (q: Queryable) => Promise<T>): Promise<T> {
    const conn = await mysql.createConnection({ ...connectionOptions(), multipleStatements: true });
    try {
        return await fn(wrap(conn));
    } finally {
        await conn.end();
    }
}

/** Wrap a pool as a {@link Queryable} for repository construction. */
export function getQueryable(pool: DbPool): Queryable {
    return wrap(pool);
}

export async function testConnection(pool: DbPool): Promise<boolean> {
    try {
        const conn = await pool.getConnection();
        try {
            await conn.query('SELECT 1');
        } finally {
            conn.release();
        }
        logger.info({ host: env.DB_HOSTNAME, port: env.DB_PORT, db: env.DB_DATABASE }, 'MySQL connected');
        return true;
    } catch (err) {
        logger.error({ err: serializeConnectionError(err) }, 'MySQL connection failed');
        return false;
    }
}

export async function withTransaction<T>(pool: DbPool, fn: (q: Queryable) => Promise<T>): Promise<T> {
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        const result = await fn(wrap(conn));
        await conn.commit();
        return result;
    } catch (err) {
        await conn.rollback();
        throw err;
    } finally {
        conn.release();
    }
}
