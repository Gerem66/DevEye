/**
 * Le schéma, lu dans une base migrée et figé dans `src/db/schema.sql`, la
 * référence lisible : un `SHOW CREATE TABLE` par table, sans le compteur
 * d'auto-incrément.
 *
 * Les tables du socle et celles des features publiques (`features.config.json`),
 * pas celles des modules privés : la CI ne les installe pas, et la sortie doit
 * être la même partout. Le script ne fait que lire, mais la base doit être
 * migrée (variables `DB_*`).
 *
 * `--check` = compare au fichier committé sans écrire ; la CI le joue sur sa
 * base jetable, une fois le smoke passé (c'est lui qui la migre).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createDbPool, getQueryable, testConnection, type Queryable } from '@/db/pool';

import { importManifest, readFeatureConfig, tablePrefix } from './lib/features-config';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHECK = process.argv.includes('--check');
const SQL_OUT = path.join(ROOT, 'src', 'db', 'schema.sql');

function fail(message: string): never {
    console.error(`gen-db-schema: ${message}`);
    process.exit(1);
}

/** Les préfixes `ft_<slug>_` des features publiques. */
async function publicPrefixes(): Promise<string[]> {
    const prefixes: string[] = [];
    for (const entry of readFeatureConfig(ROOT, 'features.config.json')) {
        const manifest = await importManifest(ROOT, entry);
        if (!manifest) fail(`${entry.package} : l'entrée racine n'exporte pas « manifest »`);
        prefixes.push(tablePrefix(manifest.id));
    }
    return prefixes;
}

async function schemaTables(q: Queryable, prefixes: string[]): Promise<string[]> {
    const r = await q.query<{ TABLE_NAME: string }>(
        `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'
          ORDER BY TABLE_NAME`
    );
    return r.rows
        .map((row) => row.TABLE_NAME)
        .filter((t) => !t.startsWith('ft_') || prefixes.some((p) => t.startsWith(p)));
}

async function renderSql(q: Queryable, tables: string[]): Promise<string> {
    const parts = ['-- Schéma généré par `npm run gen:db-schema` depuis une base migrée. Ne pas éditer.', ''];
    for (const table of tables) {
        const r = await q.query<{ 'Create Table': string }>(`SHOW CREATE TABLE \`${table}\``);
        const create = r.rows[0]?.['Create Table'];
        if (!create) fail(`SHOW CREATE TABLE ${table} n'a rien rendu`);
        // Le compteur suit les insertions : il ne décrit pas le schéma. Le jeu
        // de caractères d'une colonne n'est affiché que si elle a été posée
        // avec, ce qui dépend du chemin de migration suivi, et toute la base
        // est en utf8mb4 : la collation seule dit tout.
        const stable = create.replace(/ AUTO_INCREMENT=\d+/, '').replace(/ CHARACTER SET utf8mb4(?= COLLATE)/g, '');
        parts.push(`${stable};`, '');
    }
    return parts.join('\n');
}

async function main(): Promise<void> {
    const prefixes = await publicPrefixes();
    const pool = createDbPool();
    if (!(await testConnection(pool))) fail('connexion à la base impossible (variables DB_* ?)');
    const q = getQueryable(pool);
    try {
        const tables = await schemaTables(q, prefixes);
        if (!tables.includes('_migrations')) fail('cette base n’a jamais été migrée : pas de table _migrations');
        const content = await renderSql(q, tables);
        if (CHECK) {
            if (!fs.existsSync(SQL_OUT) || fs.readFileSync(SQL_OUT, 'utf8') !== content) {
                fail(
                    'src/db/schema.sql est en retard sur le schéma. Lancez `npm run gen:db-schema` sur une base migrée.'
                );
            }
            console.log(`gen-db-schema: schéma à jour (${tables.length} tables)`);
            return;
        }
        fs.writeFileSync(SQL_OUT, content);
        console.log(`gen-db-schema: ${tables.length} table(s) écrites dans src/db/schema.sql`);
    } finally {
        await pool.end();
    }
}

void main();
