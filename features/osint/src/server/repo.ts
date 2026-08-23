import type { OsintLookupRow, OsintProvider, OsintProviderKeyRow, OsintTargetKind } from 'deveye-types';
import type { SdkQueryable } from 'deveye-types/sdk/server';
import { randomUUID } from 'crypto';

export interface CreateOsintLookupInput {
    userId: number;
    workspaceId: number;
    kind: OsintTargetKind;
    /** Déjà chiffré par l'appelant (`ctx.cipher('private')`). Le repo ne chiffre rien. */
    queryEnc: string;
}

export interface OsintRepo {
    listLookups(workspaceId: number, limit: number): Promise<OsintLookupRow[]>;
    createLookup(input: CreateOsintLookupInput): Promise<OsintLookupRow>;
    deleteLookup(id: string, workspaceId: number): Promise<boolean>;
    /** Efface tout l'historique de l'espace ; rend le nombre de lignes retirées. */
    clearLookups(workspaceId: number): Promise<number>;
    listKeys(workspaceId: number): Promise<OsintProviderKeyRow[]>;
    getKey(workspaceId: number, provider: OsintProvider): Promise<OsintProviderKeyRow | null>;
    setKey(workspaceId: number, provider: OsintProvider, keyEnc: string): Promise<void>;
    deleteKey(workspaceId: number, provider: OsintProvider): Promise<void>;
}

/** Même dépôt qu'avant le rapatriement, porté sur le `SdkQueryable` du module. */
export function createRepo(q: SdkQueryable): OsintRepo {
    return {
        async listLookups(workspaceId, limit) {
            return q.query<OsintLookupRow>(
                'SELECT * FROM osint_lookups WHERE workspace_id = ? ORDER BY created DESC, id DESC LIMIT ?',
                [workspaceId, limit]
            );
        },
        async createLookup({ userId, workspaceId, kind, queryEnc }) {
            const id = randomUUID();
            await q.execute(
                'INSERT INTO osint_lookups (id, workspace_id, user_id, kind, query_enc) VALUES (?, ?, ?, ?, ?)',
                [id, workspaceId, userId, kind, queryEnc]
            );
            const rows = await q.query<OsintLookupRow>('SELECT * FROM osint_lookups WHERE id = ?', [id]);
            return rows[0];
        },
        async deleteLookup(id, workspaceId) {
            const res = await q.execute('DELETE FROM osint_lookups WHERE id = ? AND workspace_id = ?', [
                id,
                workspaceId
            ]);
            return res.affectedRows > 0;
        },
        async clearLookups(workspaceId) {
            const res = await q.execute('DELETE FROM osint_lookups WHERE workspace_id = ?', [workspaceId]);
            return res.affectedRows;
        },
        async listKeys(workspaceId) {
            return q.query<OsintProviderKeyRow>('SELECT * FROM osint_provider_keys WHERE workspace_id = ?', [
                workspaceId
            ]);
        },
        async getKey(workspaceId, provider) {
            const rows = await q.query<OsintProviderKeyRow>(
                'SELECT * FROM osint_provider_keys WHERE workspace_id = ? AND provider = ?',
                [workspaceId, provider]
            );
            return rows[0] ?? null;
        },
        async setKey(workspaceId, provider, keyEnc) {
            await q.execute(
                'INSERT INTO osint_provider_keys (workspace_id, provider, key_enc) VALUES (?, ?, ?) ' +
                    'ON DUPLICATE KEY UPDATE key_enc = VALUES(key_enc)',
                [workspaceId, provider, keyEnc]
            );
        },
        async deleteKey(workspaceId, provider) {
            await q.execute('DELETE FROM osint_provider_keys WHERE workspace_id = ? AND provider = ?', [
                workspaceId,
                provider
            ]);
        }
    };
}
