import SQL from '@/Services/SQL';

import type { ResultSetHeader } from 'mysql2';
import type { DBLogsType } from 'deveye-types';

export class LogsTable {
    private sql: SQL;

    constructor(sql: SQL) {
        this.sql = sql;
    }

    async Create(logData: Omit<DBLogsType, 'ID' | 'Date'>): Promise<number> {
        const query = `
            INSERT INTO Logs (UID, IP, Level, Type, Description)
            VALUES (?, ?, ?, ?, ?)
        `;
        const values = [logData.UID, logData.IP, logData.Level, logData.Type, logData.Description];

        const result = await this.sql.QueryPrepare<ResultSetHeader>(query, values);
        return result.insertId;
    }

    async Get(where: Partial<DBLogsType>, limit?: number): Promise<DBLogsType[]> {
        if (Object.keys(where).length === 0) {
            // If no criteria, turn all the logs
            const query = limit
                ? 'SELECT * FROM Logs ORDER BY Date DESC LIMIT ?'
                : 'SELECT * FROM Logs ORDER BY Date DESC';
            return limit
                ? await this.sql.QueryPrepare<DBLogsType[]>(query, [limit])
                : await this.sql.ExecQuery<DBLogsType[]>(query);
        }

        const fields = Object.keys(where)
            .map((key) => `${key} = ?`)
            .join(' AND ');
        const values = Object.values(where);

        let query = `SELECT * FROM Logs WHERE ${fields} ORDER BY Date DESC`;
        if (limit) {
            query += ' LIMIT ?';
            values.push(limit);
        }

        return await this.sql.QueryPrepare<DBLogsType[]>(query, values);
    }

    async Update(id: DBLogsType['ID'], logData: Partial<Omit<DBLogsType, 'ID' | 'Date'>>): Promise<boolean> {
        if (Object.keys(logData).length === 0) {
            return false; // Nothing to update
        }

        const fields = Object.keys(logData)
            .map((key) => `${key} = ?`)
            .join(', ');
        const values = Object.values(logData);
        values.push(id);

        const query = `UPDATE Logs SET ${fields} WHERE ID = ?`;
        const result = await this.sql.QueryPrepare<ResultSetHeader>(query, values);
        return result.affectedRows > 0;
    }

    async Delete(where: Partial<DBLogsType>): Promise<boolean> {
        if (Object.keys(where).length === 0) {
            return false; // Prevent deleting all logs
        }

        const fields = Object.keys(where)
            .map((key) => `${key} = ?`)
            .join(' AND ');
        const values = Object.values(where);

        const query = `DELETE FROM Logs WHERE ${fields}`;
        const result = await this.sql.QueryPrepare<ResultSetHeader>(query, values);
        return result.affectedRows > 0;
    }

    async Exists(where: Partial<DBLogsType>): Promise<boolean> {
        const fields = Object.keys(where)
            .map((key) => `${key} = ?`)
            .join(' AND ');
        const values = Object.values(where);

        const query = `SELECT COUNT(*) as count FROM Logs WHERE ${fields}`;
        const result = await this.sql.QueryPrepare<{ count: number }[]>(query, values);
        return result[0].count > 0;
    }

    async Count(): Promise<number> {
        const query = 'SELECT COUNT(*) as count FROM Logs';
        const result = await this.sql.ExecQuery<{ count: number }[]>(query);
        return result[0].count;
    }
}
