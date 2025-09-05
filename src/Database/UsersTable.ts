import SQL from '@/Services/SQL';

import type { ResultSetHeader } from 'mysql2';
import type { DBUserType } from 'deveye-types';

export class UsersTable {
    private sql: SQL;

    constructor(sql: SQL) {
        this.sql = sql;
    }

    async Create(userData: Omit<DBUserType, 'ID' | 'Created'>): Promise<number> {
        const query = `
            INSERT INTO Users (Email, Username, Password, ReAuthInterval, Avatar, Features, DefaultContext, DefaultFeature, Settings, Token, LastLogin)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `;
        const values = [
            userData.Email,
            userData.Username,
            userData.Password,
            userData.ReAuthInterval,
            userData.Avatar,
            userData.Features,
            userData.DefaultContext,
            userData.DefaultFeature,
            userData.Settings,
            userData.Token,
            userData.LastLogin
        ];

        const result = await this.sql.QueryPrepare<ResultSetHeader>(query, values);
        return result.insertId;
    }

    async Get(where: Partial<DBUserType>, limit?: number): Promise<DBUserType[]> {
        if (Object.keys(where).length === 0) {
            // If no criteria, return all users
            const query = limit ? 'SELECT * FROM Users LIMIT ?' : 'SELECT * FROM Users';
            return limit
                ? await this.sql.QueryPrepare<DBUserType[]>(query, [limit])
                : await this.sql.ExecQuery<DBUserType[]>(query);
        }

        const fields = Object.keys(where)
            .map((key) => `${key} = ?`)
            .join(' AND ');
        const values = Object.values(where);

        let query = `SELECT * FROM Users WHERE ${fields}`;
        if (limit) {
            query += ' LIMIT ?';
            values.push(limit);
        }

        return await this.sql.QueryPrepare<DBUserType[]>(query, values);
    }

    async GetByIds(ids: DBUserType['ID'][]): Promise<DBUserType[]> {
        if (ids.length === 0) return [];
        const placeholders = ids.map(() => '?').join(',');
        const query = `SELECT * FROM Users WHERE ID IN (${placeholders})`;
        return await this.sql.QueryPrepare<DBUserType[]>(query, ids);
    }

    async Update(id: DBUserType['ID'], userData: Partial<Omit<DBUserType, 'ID' | 'Created'>>): Promise<boolean> {
        if (Object.keys(userData).length === 0) {
            return false; // Nothing to update
        }

        const fields = Object.keys(userData)
            .map((key) => `${key} = ?`)
            .join(', ');
        const values = Object.values(userData);
        values.push(id);

        const query = `UPDATE Users SET ${fields} WHERE ID = ?`;
        const result = await this.sql.QueryPrepare<ResultSetHeader>(query, values);
        return result.affectedRows > 0;
    }

    async Delete(id: DBUserType['ID']): Promise<boolean> {
        const query = 'DELETE FROM Users WHERE ID = ?';
        const result = await this.sql.QueryPrepare<ResultSetHeader>(query, [id]);
        return result.affectedRows > 0;
    }

    async Exists(where: Partial<DBUserType>): Promise<boolean> {
        const fields = Object.keys(where)
            .map((key) => `${key} = ?`)
            .join(' AND ');
        const values = Object.values(where);

        const query = `SELECT COUNT(*) as count FROM Users WHERE ${fields}`;
        const result = await this.sql.QueryPrepare<{ count: number }[]>(query, values);
        return result[0].count > 0;
    }

    async Count(): Promise<number> {
        const query = 'SELECT COUNT(*) as count FROM Users';
        const result = await this.sql.ExecQuery<{ count: number }[]>(query);
        return result[0].count;
    }
}
