import type { SdkQueryable } from '@deveye/types/sdk/server';

export interface SignatureRow {
    id: number;
    workspace_id: number;
    user_id: number;
    role: 'signature' | 'initials';
    data_enc: string;
    created: number | string;
}

export interface NewSignature {
    workspaceId: number;
    userId: number;
    role: 'signature' | 'initials';
    dataEnc: string;
    at: number;
}

export interface PdfRepo {
    /** Les signatures d'un compte, la plus récente d'abord. */
    signatures(userId: number): Promise<SignatureRow[]>;
    countSignatures(userId: number): Promise<number>;
    insertSignature(row: NewSignature): Promise<number>;
    /** Vrai si la ligne était à ce compte et est partie. */
    removeSignature(id: number, userId: number): Promise<boolean>;
}

export function createRepo(q: SdkQueryable): PdfRepo {
    return {
        signatures: (userId) =>
            q.query<SignatureRow>('SELECT * FROM ft_pdf_signatures WHERE user_id = ? ORDER BY created DESC, id DESC', [
                userId
            ]),

        async countSignatures(userId) {
            const rows = await q.query<{ total: number | string }>(
                'SELECT COUNT(*) AS total FROM ft_pdf_signatures WHERE user_id = ?',
                [userId]
            );
            return Number(rows[0]?.total ?? 0);
        },

        async insertSignature(row) {
            const result = await q.execute(
                `INSERT INTO ft_pdf_signatures (workspace_id, user_id, role, data_enc, created)
                 VALUES (?, ?, ?, ?, ?)`,
                [row.workspaceId, row.userId, row.role, row.dataEnc, row.at]
            );
            return result.insertId;
        },

        async removeSignature(id, userId) {
            const result = await q.execute('DELETE FROM ft_pdf_signatures WHERE id = ? AND user_id = ?', [id, userId]);
            return result.affectedRows === 1;
        }
    };
}
