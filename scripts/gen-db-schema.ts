/**
 * Le schéma du socle, lu dans une base migrée et figé en deux fichiers committés :
 *  - `src/db/schema.sql`, la référence lisible : un `SHOW CREATE TABLE` par
 *    table, sans le compteur d'auto-incrément ;
 *  - `src/db/schema.generated.ts`, le type `Tables` que
 *    `src/db/schema.assertions.ts` confronte aux types de lignes des dépôts.
 *
 * Seules les tables du socle : les modules créent les leurs sous `ft_<slug>_`,
 * et la CI n'installe pas les privés, la sortie doit être la même partout.
 * Le script ne fait que lire, mais la base doit être migrée (variables `DB_*`).
 *
 * `--check` = compare aux fichiers committés sans écrire ; la CI le joue sur sa
 * base jetable, une fois le smoke passé (c'est lui qui la migre).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import prettier from 'prettier';

import { createDbPool, getQueryable, testConnection, type Queryable } from '@/db/pool';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHECK = process.argv.includes('--check');
const SQL_OUT = path.join(ROOT, 'src', 'db', 'schema.sql');
const TS_OUT = path.join(ROOT, 'src', 'db', 'schema.generated.ts');

function fail(message: string): never {
    console.error(`gen-db-schema: ${message}`);
    process.exit(1);
}

interface ColumnRow {
    TABLE_NAME: string;
    COLUMN_NAME: string;
    DATA_TYPE: string;
    COLUMN_TYPE: string;
    IS_NULLABLE: 'YES' | 'NO';
}

async function coreTables(q: Queryable): Promise<string[]> {
    const r = await q.query<{ TABLE_NAME: string }>(
        `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE' AND TABLE_NAME NOT LIKE 'ft\\_%'
          ORDER BY TABLE_NAME`
    );
    return r.rows.map((row) => row.TABLE_NAME);
}

async function coreColumns(q: Queryable): Promise<ColumnRow[]> {
    const r = await q.query<ColumnRow>(
        `SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE, COLUMN_TYPE, IS_NULLABLE
           FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME NOT LIKE 'ft\\_%'
          ORDER BY TABLE_NAME, ORDINAL_POSITION`
    );
    return r.rows;
}

async function renderSql(q: Queryable, tables: string[]): Promise<string> {
    const parts = ['-- Schéma du socle, généré par `npm run gen:db-schema` depuis une base migrée. Ne pas éditer.', ''];
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

/** `enum('a','b')` devient `'a' | 'b'`. */
function enumUnion(columnType: string): string {
    const inner = columnType.slice(columnType.indexOf('(') + 1, columnType.lastIndexOf(')'));
    const values = inner.match(/'(?:[^']|'')*'/g) ?? [];
    return values.map((v) => `'${v.slice(1, -1).replace(/''/g, "\\'")}'`).join(' | ');
}

/**
 * Ce que `mysql2` rend pour une colonne, avec les options du pool : les BIGINT
 * en nombre (pas de `supportBigNumbers`), les DECIMAL en chaîne, les dates en
 * `Date`, les JSON décodés ou non selon le chemin, donc `unknown`.
 */
function baseType(c: ColumnRow): string {
    switch (c.DATA_TYPE) {
        case 'tinyint':
        case 'smallint':
        case 'mediumint':
        case 'int':
        case 'integer':
        case 'bigint':
        case 'float':
        case 'double':
        case 'year':
            return 'number';
        case 'decimal':
        case 'numeric':
        case 'time':
        case 'char':
        case 'varchar':
        case 'tinytext':
        case 'text':
        case 'mediumtext':
        case 'longtext':
        case 'set':
            return 'string';
        case 'enum':
            return enumUnion(c.COLUMN_TYPE);
        case 'json':
            return 'unknown';
        case 'date':
        case 'datetime':
        case 'timestamp':
            return 'Date';
        case 'bit':
        case 'binary':
        case 'varbinary':
        case 'tinyblob':
        case 'blob':
        case 'mediumblob':
        case 'longblob':
            return 'Buffer';
        default:
            return fail(`type de colonne non prévu : ${c.DATA_TYPE} (${c.TABLE_NAME}.${c.COLUMN_NAME})`);
    }
}

const key = (name: string): string => (/^[A-Za-z_$][\w$]*$/.test(name) ? name : `'${name}'`);

async function renderTs(tables: string[], columns: ColumnRow[]): Promise<string> {
    const lines = [
        '// Généré par `npm run gen:db-schema` depuis une base migrée. Ne pas éditer.',
        '',
        '/** Les tables du socle, colonne par colonne, telles que `mysql2` les rend. */',
        'export interface Tables {'
    ];
    for (const table of tables) {
        lines.push(`    ${key(table)}: {`);
        for (const c of columns.filter((col) => col.TABLE_NAME === table)) {
            const type = c.IS_NULLABLE === 'YES' ? `${baseType(c)} | null` : baseType(c);
            lines.push(`        ${key(c.COLUMN_NAME)}: ${type};`);
        }
        lines.push('    };');
    }
    lines.push('}', '', 'export type TableName = keyof Tables;', '');
    // `format` seul ignore `prettier.config.js` : la config se résout à part.
    const options = await prettier.resolveConfig(TS_OUT);
    return prettier.format(lines.join('\n'), { ...options, filepath: TS_OUT });
}

async function main(): Promise<void> {
    const pool = createDbPool();
    if (!(await testConnection(pool))) fail('connexion à la base impossible (variables DB_* ?)');
    const q = getQueryable(pool);
    try {
        const tables = await coreTables(q);
        if (!tables.includes('_migrations')) fail('cette base n’a jamais été migrée : pas de table _migrations');
        const outputs = [
            { file: SQL_OUT, content: await renderSql(q, tables) },
            { file: TS_OUT, content: await renderTs(tables, await coreColumns(q)) }
        ];
        if (CHECK) {
            const stale = outputs
                .filter((o) => !fs.existsSync(o.file) || fs.readFileSync(o.file, 'utf8') !== o.content)
                .map((o) => path.relative(ROOT, o.file));
            if (stale.length > 0) {
                fail(
                    `fichiers générés en retard sur le schéma : ${stale.join(', ')}. ` +
                        'Lancez `npm run gen:db-schema` sur une base migrée.'
                );
            }
            console.log(`gen-db-schema: schéma à jour (${tables.length} tables du socle)`);
            return;
        }
        for (const o of outputs) fs.writeFileSync(o.file, o.content);
        console.log(`gen-db-schema: ${tables.length} table(s) du socle écrites dans src/db/`);
    } finally {
        await pool.end();
    }
}

void main();
