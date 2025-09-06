import SQL from '@/Services/SQL';

import type { ResultSetHeader } from 'mysql2';
import type { DBType_Workspace_Raw } from 'deveye-types';

export class WorkspacesTable {
    private sql: SQL;

    constructor(sql: SQL) {
        this.sql = sql;
    }

    async Create(workspaceName: DBType_Workspace_Raw['Name']): Promise<number> {
        const result = await this.sql.QueryPrepare<ResultSetHeader>(
            `
            INSERT INTO Workspaces (Name)
            VALUES (?)
        `,
            [workspaceName]
        );
        return result.insertId;
    }

    async Get(where: Partial<DBType_Workspace_Raw>, limit?: number): Promise<DBType_Workspace_Raw[]> {
        if (Object.keys(where).length === 0) {
            // If no criteria, turn all the workspaces
            const query = limit ? 'SELECT * FROM Workspaces LIMIT ?' : 'SELECT * FROM Workspaces';
            return limit
                ? await this.sql.QueryPrepare<DBType_Workspace_Raw[]>(query, [limit])
                : await this.sql.ExecQuery<DBType_Workspace_Raw[]>(query);
        }

        const fields = Object.keys(where)
            .map((key) => `${key} = ?`)
            .join(' AND ');
        const values = Object.values(where);

        let query = `SELECT * FROM Workspaces WHERE ${fields}`;
        if (limit) {
            query += ' LIMIT ?';
            values.push(limit);
        }

        return await this.sql.QueryPrepare<DBType_Workspace_Raw[]>(query, values);
    }

    async GetWorkspacesWithUserAccess(userId: number): Promise<DBType_Workspace_Raw[]> {
        const query = `
            SELECT c.* FROM Workspaces c
            INNER JOIN WorkspaceMembers cl ON c.ID = cl.WorkspaceID
            WHERE cl.UserID = ?
        `;
        return await this.sql.QueryPrepare<DBType_Workspace_Raw[]>(query, [userId]);
    }

    async Update(
        id: DBType_Workspace_Raw['ID'],
        workspaceData: Partial<Omit<DBType_Workspace_Raw, 'ID' | 'Created'>>
    ): Promise<boolean> {
        if (Object.keys(workspaceData).length === 0) {
            return false; // Nothing to update
        }

        const fields = Object.keys(workspaceData)
            .map((key) => `${key} = ?`)
            .join(', ');
        const values = Object.values(workspaceData);
        values.push(id);

        const query = `UPDATE Workspaces SET ${fields} WHERE ID = ?`;
        const result = await this.sql.QueryPrepare<ResultSetHeader>(query, values);
        return result.affectedRows > 0;
    }

    async Delete(id: DBType_Workspace_Raw['ID']): Promise<boolean> {
        const query = 'DELETE FROM Workspaces WHERE ID = ?';
        const result = await this.sql.QueryPrepare<ResultSetHeader>(query, [id]);
        return result.affectedRows > 0;
    }

    async Exists(where: Partial<DBType_Workspace_Raw>): Promise<boolean> {
        const fields = Object.keys(where)
            .map((key) => `${key} = ?`)
            .join(' AND ');
        const values = Object.values(where);

        const query = `SELECT COUNT(*) as count FROM Workspaces WHERE ${fields}`;
        const result = await this.sql.QueryPrepare<{ count: number }[]>(query, values);
        return result[0].count > 0;
    }

    async Count(): Promise<number> {
        const query = 'SELECT COUNT(*) as count FROM Workspaces';
        const result = await this.sql.ExecQuery<{ count: number }[]>(query);
        return result[0].count;
    }
}
