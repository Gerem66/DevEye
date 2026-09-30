import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { logger } from '@/logger';
import { withSqlFileConnection, type Queryable } from './pool';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

/** Un répertoire de migrations d'un module de feature (voir `FeatureServer`). */
export interface ModuleMigrations {
    /** L'id du module : le préfixe sous lequel ses fichiers s'enregistrent. */
    id: string;
    dir: string;
}

async function applyDir(q: Queryable, applied: Set<string>, dir: string, prefix: string): Promise<void> {
    const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
        const name = prefix + file;
        if (applied.has(name)) continue;
        const sql = await fs.readFile(path.join(dir, file), 'utf8');
        logger.info({ migration: name }, 'Applying migration');
        // Le DDL de MySQL committe implicitement : aucune transaction annulable
        // n'est possible autour d'une migration. Le fichier entier part en une
        // requête, sur la connexion multi-instructions.
        await q.query(sql);
        await q.query('INSERT INTO _migrations (name) VALUES (?)', [name]);
    }
}

/**
 * Rejoue le socle puis les modules. Le socle s'enregistre au nom de fichier nu
 * (`0NN_*.sql`), chaque module sous `<id>/<fichier>` : le slash rend toute
 * collision impossible. Tout le socle avant tous les modules (il fonde ce
 * qu'ils référencent), les modules dans l'ordre de la config.
 */
export async function runMigrations(modules: readonly ModuleMigrations[] = []): Promise<void> {
    await withSqlFileConnection(async (q) => {
        await q.query(`
            CREATE TABLE IF NOT EXISTS _migrations (
                name        VARCHAR(255) PRIMARY KEY,
                applied_at  BIGINT       NOT NULL DEFAULT (UNIX_TIMESTAMP())
            )
        `);

        const res = await q.query<{ name: string }>('SELECT name FROM _migrations');
        const applied = new Set(res.rows.map((r) => r.name));

        await applyDir(q, applied, MIGRATIONS_DIR, '');
        for (const mod of modules) {
            await applyDir(q, applied, mod.dir, `${mod.id}/`);
        }
    });
    logger.info('Migrations up to date');
}
