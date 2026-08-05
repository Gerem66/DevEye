import type { Queryable } from '../pool';

type Q = Queryable;

export interface WorkspaceSecretKeyRow {
    workspace_id: number;
    dek_wrapped: string;
    created: number;
    updated: number;
}

export interface WorkspaceSecretKeysRepo {
    get(workspaceId: number): Promise<WorkspaceSecretKeyRow | null>;
    /**
     * Pose la clé si l'espace n'en a pas encore. Sans effet sinon — la clé
     * existante est celle sous laquelle le contenu a été écrit, l'écraser le
     * rendrait illisible. Renvoie la ligne finalement en place.
     */
    create(workspaceId: number, dekWrapped: string): Promise<WorkspaceSecretKeyRow>;
}

export function workspaceSecretKeysRepo(pool: Q): WorkspaceSecretKeysRepo {
    return {
        async get(workspaceId) {
            const r = await pool.query<WorkspaceSecretKeyRow>(
                'SELECT * FROM workspace_secret_keys WHERE workspace_id = ?',
                [workspaceId]
            );
            return r.rows[0] ?? null;
        },
        async create(workspaceId, dekWrapped) {
            // INSERT IGNORE plutôt que REPLACE : deux créations concurrentes ne
            // doivent pas produire deux clés, la première gagne.
            await pool.query('INSERT IGNORE INTO workspace_secret_keys (workspace_id, dek_wrapped) VALUES (?, ?)', [
                workspaceId,
                dekWrapped
            ]);
            const row = await this.get(workspaceId);
            if (!row) throw new Error('Failed to create workspace DEK');
            return row;
        }
    };
}
