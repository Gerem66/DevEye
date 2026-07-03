import type { Queryable } from '../pool';

/**
 * Métadonnées du sous-système CloudSync (une ligne par clé). Seule clé à ce
 * jour : `blob_key_wrapped`, la Blob Master Key wrappée par la clé serveur
 * (voir src/cloudSync/blobCrypto.ts).
 */
export interface SyncMetaRepo {
    get(key: string): Promise<string | null>;
    set(key: string, value: string): Promise<void>;
}

export function syncMetaRepo(pool: Queryable): SyncMetaRepo {
    return {
        async get(key) {
            const r = await pool.query<{ v: string }>('SELECT v FROM sync_meta WHERE k = ?', [key]);
            return r.rows[0]?.v ?? null;
        },
        async set(key, value) {
            await pool.query('INSERT INTO sync_meta (k, v) VALUES (?, ?) ON DUPLICATE KEY UPDATE v = VALUES(v)', [
                key,
                value
            ]);
        }
    };
}
