import type { PasswordRow } from 'deveye-types';
import type { Queryable } from '../pool';

type Q = Queryable;

export interface PasswordsRepo {
    listByUser(userId: number): Promise<PasswordRow[]>;
    findById(id: number, userId: number): Promise<PasswordRow | null>;
    create(input: { userId: number; workspaceId: number | null; content: string }): Promise<PasswordRow>;
    update(id: number, userId: number, content: string): Promise<PasswordRow | null>;
    delete(id: number, userId: number): Promise<boolean>;
}

export function passwordsRepo(pool: Q): PasswordsRepo {
    return {
        async listByUser(userId) {
            const r = await pool.query<PasswordRow>(
                'SELECT * FROM passwords WHERE user_id = ? ORDER BY id ASC',
                [userId]
            );
            return r.rows;
        },
        async findById(id, userId) {
            const r = await pool.query<PasswordRow>(
                'SELECT * FROM passwords WHERE id = ? AND user_id = ?',
                [id, userId]
            );
            return r.rows[0] ?? null;
        },
        async create({ userId, workspaceId, content }) {
            const res = await pool.query(
                `INSERT INTO passwords (user_id, workspace_id, content)
                 VALUES (?, ?, ?)`,
                [userId, workspaceId, content]
            );
            const r = await pool.query<PasswordRow>('SELECT * FROM passwords WHERE id = ?', [
                res.insertId
            ]);
            return r.rows[0];
        },
        async update(id, userId, content) {
            const res = await pool.query(
                `UPDATE passwords SET content = ?
                 WHERE id = ? AND user_id = ?`,
                [content, id, userId]
            );
            if (res.rowCount === 0) return null;
            const r = await pool.query<PasswordRow>(
                'SELECT * FROM passwords WHERE id = ? AND user_id = ?',
                [id, userId]
            );
            return r.rows[0] ?? null;
        },
        async delete(id, userId) {
            const r = await pool.query('DELETE FROM passwords WHERE id = ? AND user_id = ?', [
                id,
                userId
            ]);
            return r.rowCount > 0;
        }
    };
}
