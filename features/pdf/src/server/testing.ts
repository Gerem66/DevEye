import type { PdfRepo, SignatureRow } from './repo';

/** Le dépôt en mémoire des tests : les mêmes gardes que le SQL, une ligne n'appartient qu'à son compte. */
export interface MemoryRepo extends PdfRepo {
    rows: SignatureRow[];
}

export function memoryRepo(): MemoryRepo {
    const rows: SignatureRow[] = [];
    return {
        rows,
        signatures: (userId) =>
            Promise.resolve(
                rows.filter((r) => r.user_id === userId).sort((a, b) => Number(b.created) - Number(a.created))
            ),
        countSignatures: (userId) => Promise.resolve(rows.filter((r) => r.user_id === userId).length),
        insertSignature(row) {
            const id = rows.length + 1;
            rows.push({
                id,
                workspace_id: row.workspaceId,
                user_id: row.userId,
                role: row.role,
                data_enc: row.dataEnc,
                created: row.at
            });
            return Promise.resolve(id);
        },
        removeSignature(id, userId) {
            const at = rows.findIndex((r) => r.id === id && r.user_id === userId);
            if (at === -1) return Promise.resolve(false);
            rows.splice(at, 1);
            return Promise.resolve(true);
        }
    };
}
