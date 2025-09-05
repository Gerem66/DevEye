import SQL from '@/Services/SQL';

import type { ResultSetHeader } from 'mysql2';
import type { DBContextType } from 'deveye-types';

export class ContextsTable {
    private sql: SQL;

    constructor(sql: SQL) {
        this.sql = sql;
    }

    async Create(contextData: Omit<DBContextType, 'ID' | 'Created'>): Promise<number> {
        const query = `
            INSERT INTO Contexts (Name, Logo, Features, Password, ReAuthInterval)
            VALUES (?, ?, ?, ?, ?)
        `;
        const values = [
            contextData.Name,
            contextData.Logo,
            contextData.Features,
            contextData.Password,
            contextData.ReAuthInterval
        ];

        const result = await this.sql.QueryPrepare<ResultSetHeader>(query, values);
        return result.insertId;
    }

    async Get(where: Partial<DBContextType>, limit?: number): Promise<DBContextType[]> {
        if (Object.keys(where).length === 0) {
            // If no criteria, turn all the contexts
            const query = limit ? 'SELECT * FROM Contexts LIMIT ?' : 'SELECT * FROM Contexts';
            return limit
                ? await this.sql.QueryPrepare<DBContextType[]>(query, [limit])
                : await this.sql.ExecQuery<DBContextType[]>(query);
        }

        const fields = Object.keys(where)
            .map((key) => `${key} = ?`)
            .join(' AND ');
        const values = Object.values(where);

        let query = `SELECT * FROM Contexts WHERE ${fields}`;
        if (limit) {
            query += ' LIMIT ?';
            values.push(limit);
        }

        return await this.sql.QueryPrepare<DBContextType[]>(query, values);
    }

    async GetContextsWithUserAccess(userId: number): Promise<DBContextType[]> {
        const query = `
            SELECT c.* FROM Contexts c
            INNER JOIN ContextsLinks cl ON c.ID = cl.ContextID
            WHERE cl.UserID = ?
        `;
        return await this.sql.QueryPrepare<DBContextType[]>(query, [userId]);
    }

    async Update(
        id: DBContextType['ID'],
        contextData: Partial<Omit<DBContextType, 'ID' | 'Created'>>
    ): Promise<boolean> {
        if (Object.keys(contextData).length === 0) {
            return false; // Nothing to update
        }

        const fields = Object.keys(contextData)
            .map((key) => `${key} = ?`)
            .join(', ');
        const values = Object.values(contextData);
        values.push(id);

        const query = `UPDATE Contexts SET ${fields} WHERE ID = ?`;
        const result = await this.sql.QueryPrepare<ResultSetHeader>(query, values);
        return result.affectedRows > 0;
    }

    async Delete(id: DBContextType['ID']): Promise<boolean> {
        const query = 'DELETE FROM Contexts WHERE ID = ?';
        const result = await this.sql.QueryPrepare<ResultSetHeader>(query, [id]);
        return result.affectedRows > 0;
    }

    async Exists(where: Partial<DBContextType>): Promise<boolean> {
        const fields = Object.keys(where)
            .map((key) => `${key} = ?`)
            .join(' AND ');
        const values = Object.values(where);

        const query = `SELECT COUNT(*) as count FROM Contexts WHERE ${fields}`;
        const result = await this.sql.QueryPrepare<{ count: number }[]>(query, values);
        return result[0].count > 0;
    }

    async Count(): Promise<number> {
        const query = 'SELECT COUNT(*) as count FROM Contexts';
        const result = await this.sql.ExecQuery<{ count: number }[]>(query);
        return result[0].count;
    }
}
