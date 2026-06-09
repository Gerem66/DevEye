import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { logger } from '@/logger';
import { getQueryable, type DbPool } from './pool';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

export async function runMigrations(pool: DbPool): Promise<void> {
    const q = getQueryable(pool);

    await q.query(`
        CREATE TABLE IF NOT EXISTS _migrations (
            name        VARCHAR(255) PRIMARY KEY,
            applied_at  BIGINT       NOT NULL DEFAULT (UNIX_TIMESTAMP())
        )
    `);

    const res = await q.query<{ name: string }>('SELECT name FROM _migrations');
    const applied = new Set(res.rows.map((r) => r.name));

    const files = (await fs.readdir(MIGRATIONS_DIR))
        .filter((f) => f.endsWith('.sql'))
        .sort();

    for (const file of files) {
        if (applied.has(file)) continue;
        const sql = await fs.readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
        logger.info({ migration: file }, 'Applying migration');
        // MySQL DDL implicitly commits, so migrations cannot run inside a
        // rollback-able transaction. The pool enables `multipleStatements`,
        // letting the whole migration file run in a single query.
        await q.query(sql);
        await q.query('INSERT INTO _migrations (name) VALUES (?)', [file]);
    }
    logger.info('Migrations up to date');
}

