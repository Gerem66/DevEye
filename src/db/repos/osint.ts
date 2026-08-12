import type { OsintLookupRow, OsintProvider, OsintProviderKeyRow, OsintTargetKind } from 'deveye-types';
import { randomUUID } from 'crypto';
import type { Queryable } from '../pool';

type Q = Queryable;

export interface CreateOsintLookupInput {
    userId: number;
    workspaceId: number;
    kind: OsintTargetKind;
    /** Déjà chiffré par l'appelant (`ctx.secure`). Le repo ne chiffre rien. */
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

export function osintRepo(pool: Q): OsintRepo {
    return {
        async listLookups(workspaceId, limit) {
            const r = await pool.query<OsintLookupRow>(
                'SELECT * FROM osint_lookups WHERE workspace_id = ? ORDER BY created DESC, id DESC LIMIT ?',
                [workspaceId, limit]
            );
            return r.rows;
        },
        async createLookup({ userId, workspaceId, kind, queryEnc }) {
            const id = randomUUID();
            await pool.query(
                'INSERT INTO osint_lookups (id, workspace_id, user_id, kind, query_enc) VALUES (?, ?, ?, ?, ?)',
                [id, workspaceId, userId, kind, queryEnc]
            );
            const r = await pool.query<OsintLookupRow>('SELECT * FROM osint_lookups WHERE id = ?', [id]);
            return r.rows[0];
        },
        async deleteLookup(id, workspaceId) {
            const r = await pool.query('DELETE FROM osint_lookups WHERE id = ? AND workspace_id = ?', [
                id,
                workspaceId
            ]);
            return r.rowCount > 0;
        },
        async clearLookups(workspaceId) {
            const r = await pool.query('DELETE FROM osint_lookups WHERE workspace_id = ?', [workspaceId]);
            return r.rowCount;
        },
        async listKeys(workspaceId) {
            const r = await pool.query<OsintProviderKeyRow>(
                'SELECT * FROM osint_provider_keys WHERE workspace_id = ?',
                [workspaceId]
            );
            return r.rows;
        },
        async getKey(workspaceId, provider) {
            const r = await pool.query<OsintProviderKeyRow>(
                'SELECT * FROM osint_provider_keys WHERE workspace_id = ? AND provider = ?',
                [workspaceId, provider]
            );
            return r.rows[0] ?? null;
        },
        async setKey(workspaceId, provider, keyEnc) {
            await pool.query(
                'INSERT INTO osint_provider_keys (workspace_id, provider, key_enc) VALUES (?, ?, ?) ' +
                    'ON DUPLICATE KEY UPDATE key_enc = VALUES(key_enc)',
                [workspaceId, provider, keyEnc]
            );
        },
        async deleteKey(workspaceId, provider) {
            await pool.query('DELETE FROM osint_provider_keys WHERE workspace_id = ? AND provider = ?', [
                workspaceId,
                provider
            ]);
        }
    };
}
