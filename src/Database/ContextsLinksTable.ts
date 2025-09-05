import SQL from '@/Services/SQL';

import type { ResultSetHeader } from 'mysql2';
import type { DBContextsLinksType } from 'deveye-types';

export class ContextsLinksTable {
    private sql: SQL;

    constructor(sql: SQL) {
        this.sql = sql;
    }

    async Create(linkData: Omit<DBContextsLinksType, 'ID' | 'Date'>): Promise<number> {
        const query = `
            INSERT INTO ContextsLinks (UserID, ContextID, Roles)
            VALUES (?, ?, ?)
        `;
        const values = [linkData.UserID, linkData.ContextID, linkData.Roles];

        const result = await this.sql.QueryPrepare<ResultSetHeader>(query, values);
        return result.insertId;
    }

    async Get(where: Partial<DBContextsLinksType>, limit?: number): Promise<DBContextsLinksType[]> {
        if (Object.keys(where).length === 0) {
            // If no criteria, return all links
            const query = limit ? 'SELECT * FROM ContextsLinks LIMIT ?' : 'SELECT * FROM ContextsLinks';
            return limit
                ? await this.sql.QueryPrepare<DBContextsLinksType[]>(query, [limit])
                : await this.sql.ExecQuery<DBContextsLinksType[]>(query);
        }

        const fields = Object.keys(where)
            .map((key) => `${key} = ?`)
            .join(' AND ');
        const values = Object.values(where);

        let query = `SELECT * FROM ContextsLinks WHERE ${fields}`;
        if (limit) {
            query += ' LIMIT ?';
            values.push(limit);
        }

        return await this.sql.QueryPrepare<DBContextsLinksType[]>(query, values);
    }

    async Update(
        id: DBContextsLinksType['ID'],
        linkData: Partial<Omit<DBContextsLinksType, 'ID' | 'Date'>>
    ): Promise<boolean> {
        if (Object.keys(linkData).length === 0) {
            return false; // Nothing to update
        }

        const fields = Object.keys(linkData)
            .map((key) => `${key} = ?`)
            .join(', ');
        const values = Object.values(linkData);
        values.push(id);

        const query = `UPDATE ContextsLinks SET ${fields} WHERE ID = ?`;
        const result = await this.sql.QueryPrepare<ResultSetHeader>(query, values);
        return result.affectedRows > 0;
    }

    async Delete(where: Partial<DBContextsLinksType>): Promise<boolean> {
        if (Object.keys(where).length === 0) {
            return false; // Prevent deleting all links
        }

        const fields = Object.keys(where)
            .map((key) => `${key} = ?`)
            .join(' AND ');
        const values = Object.values(where);

        const query = `DELETE FROM ContextsLinks WHERE ${fields}`;
        const result = await this.sql.QueryPrepare<ResultSetHeader>(query, values);
        return result.affectedRows > 0;
    }

    async Exists(where: Partial<DBContextsLinksType>): Promise<boolean> {
        const fields = Object.keys(where)
            .map((key) => `${key} = ?`)
            .join(' AND ');
        const values = Object.values(where);

        const query = `SELECT COUNT(*) as count FROM ContextsLinks WHERE ${fields}`;
        const result = await this.sql.QueryPrepare<{ count: number }[]>(query, values);
        return result[0].count > 0;
    }

    async Count(): Promise<number> {
        const query = 'SELECT COUNT(*) as count FROM ContextsLinks';
        const result = await this.sql.ExecQuery<{ count: number }[]>(query);
        return result[0].count;
    }
}
