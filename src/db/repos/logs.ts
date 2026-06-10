import type { LogRow } from 'deveye-types';
import type { Queryable } from '../pool';

type Q = Queryable;

export interface LogsRepo {
    record(input: { uid: number; ip: string; level: number; type: string; description: string }): Promise<void>;
    list(filter: { uid?: number; type?: string }, limit?: number): Promise<LogRow[]>;
}

export function logsRepo(pool: Q): LogsRepo {
    return {
        async record({ uid, ip, level, type, description }) {
            await pool.query(
                `INSERT INTO logs (uid, ip, level, type, description)
                 VALUES (?, ?, ?, ?, ?)`,
                [uid, ip, level, type, description]
            );
        },
        async list(filter, limit = 100) {
            const conds: string[] = [];
            const params: (string | number)[] = [];
            if (filter.uid !== undefined) {
                params.push(filter.uid);
                conds.push('uid = ?');
            }
            if (filter.type !== undefined) {
                params.push(filter.type);
                conds.push('type = ?');
            }
            const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
            params.push(limit);
            const r = await pool.query<LogRow>(`SELECT * FROM logs ${where} ORDER BY date DESC LIMIT ?`, params);
            return r.rows;
        }
    };
}
