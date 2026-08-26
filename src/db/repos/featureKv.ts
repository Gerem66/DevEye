import type { Queryable } from '../pool';

type Q = Queryable;

/** Ligne de `feature_kv` (voir la migration 095). */
export interface FeatureKvRow {
    workspace_id: number;
    feature: string;
    k: string;
    mode: 'server' | 'private' | 'none';
    value: string;
    updated: number;
}

/**
 * Le magasin clé-valeur des modules de features.
 *
 * Le repo ne chiffre jamais : `value` arrive déjà scellée (ou en clair pour le
 * mode 'none'), c'est le FeatureStore du SDK qui choisit le cipher. Le mode est
 * figé sur la ligne pour que la lecture sache toujours comment déchiffrer.
 */
export interface FeatureKvRepo {
    get(workspaceId: number, feature: string, key: string): Promise<FeatureKvRow | null>;
    put(workspaceId: number, feature: string, key: string, mode: FeatureKvRow['mode'], value: string): Promise<void>;
    remove(workspaceId: number, feature: string, key: string): Promise<void>;
    keys(workspaceId: number, feature: string, prefix: string): Promise<string[]>;
}

export function featureKvRepo(pool: Q): FeatureKvRepo {
    return {
        async get(workspaceId, feature, key) {
            const r = await pool.query<FeatureKvRow>(
                'SELECT workspace_id, feature, k, mode, value, updated FROM feature_kv WHERE workspace_id = ? AND feature = ? AND k = ?',
                [workspaceId, feature, key]
            );
            return r.rows[0] ?? null;
        },
        async put(workspaceId, feature, key, mode, value) {
            await pool.query(
                `INSERT INTO feature_kv (workspace_id, feature, k, mode, value, updated)
                 VALUES (?, ?, ?, ?, ?, UNIX_TIMESTAMP())
                 ON DUPLICATE KEY UPDATE mode = VALUES(mode), value = VALUES(value), updated = UNIX_TIMESTAMP()`,
                [workspaceId, feature, key, mode, value]
            );
        },
        async remove(workspaceId, feature, key) {
            await pool.query('DELETE FROM feature_kv WHERE workspace_id = ? AND feature = ? AND k = ?', [
                workspaceId,
                feature,
                key
            ]);
        },
        async keys(workspaceId, feature, prefix) {
            // Le préfixe est un texte, pas un motif : `%` et `_` s'échappent.
            const r = await pool.query<{ k: string }>(
                "SELECT k FROM feature_kv WHERE workspace_id = ? AND feature = ? AND k LIKE CONCAT(?, '%') ORDER BY k",
                [workspaceId, feature, prefix.replace(/[\\%_]/g, '\\$&')]
            );
            return r.rows.map((row) => row.k);
        }
    };
}
