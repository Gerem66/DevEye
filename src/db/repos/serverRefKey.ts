import type { Queryable } from '../pool';

/** La racine des condensés à clé (`Services/refKeys.ts`) : une seule ligne, scellée par la clé serveur. */
export interface ServerRefKeyRepo {
    sealed(): Promise<string | null>;
    /** Sans effet si la ligne existe : deux démarrages simultanés gardent la même racine. */
    insertSealed(sealed: string): Promise<void>;
}

export function serverRefKeyRepo(pool: Queryable): ServerRefKeyRepo {
    return {
        async sealed() {
            const r = await pool.query<{ sealed: string }>('SELECT sealed FROM server_ref_key WHERE id = 1', []);
            return r.rows[0]?.sealed ?? null;
        },
        async insertSealed(sealed) {
            await pool.query('INSERT IGNORE INTO server_ref_key (id, sealed) VALUES (1, ?)', [sealed]);
        }
    };
}
