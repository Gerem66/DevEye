/**
 * `npm run check:queries` : chaque requête que le serveur envoie à sa base
 * (socle, features, modules installés par `features.local.json`) est préparée
 * sur une base migrée, puis confrontée au type de ligne qu'elle annonce.
 *
 *  - la requête se prépare : syntaxe, tables, colonnes ;
 *  - autant de `?` que de paramètres, quand ceux-ci sont un tableau littéral ;
 *  - chaque champ de `query<T>` est une colonne rendue, d'un type que mysql2
 *    rend bien (un DECIMAL en chaîne, un NULL possible déclaré).
 *
 * Préparer n'exécute rien : le contrôle se lance sans risque sur n'importe
 * quelle base migrée, celle du dev comprise (variables `DB_*`).
 *
 * Un appel se repère au vérificateur de types : sa méthode est celle de
 * `Queryable` (le socle) ou de `SdkQueryable` (les modules). Le SQL qui ne se
 * réduit pas à des chaînes connues est compté à part (`--verbose` le liste).
 * `// check-queries: ignore <raison>` juste avant un appel l'écarte.
 *
 * Puis chaque requête est relue pour son cloisonnement (`lib/scope-pass.ts`) :
 * les tables qu'elle cite sont-elles bornées à un espace ou à un compte ?
 * `--scope-report` ne fait que cela, sans rien préparer ni faire échouer, et
 * compte dépôt par dépôt.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import mysql from 'mysql2';
import ts from 'typescript';

import { connectionOptions } from '@/db/pool';

import {
    columnShape,
    DynamicSql,
    enumValues,
    expandBulkValues,
    inlinePlaceholders,
    fieldShape,
    nullContext,
    misfit,
    sqlVariants,
    type ColumnShape,
    type PreparedColumn,
    type SchemaColumn
} from './lib/query-check';
import { findQueryCalls, ignoreReason, loadProgram, paramCount, whereOf } from './lib/query-calls';
import { scopePass } from './lib/scope-pass';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKSPACE = path.dirname(ROOT);
const VERBOSE = process.argv.includes('--verbose');
const SCOPE_REPORT = process.argv.includes('--scope-report');

interface Prepared {
    columns: ColumnShape[];
    parameters: number;
}

type PrepareResult = { ok: Prepared } | { error: string; code: string };

interface Problem {
    where: string;
    message: string;
}

/** Le type de ligne annoncé, quand il en a un à vérifier (pas le `RowDataPacket` de mysql2, ni un générique). */
function rowType(call: ts.CallExpression, checker: ts.TypeChecker): ts.Type | null {
    const node = call.typeArguments?.[0];
    if (!node) return null;
    const type = checker.getTypeFromTypeNode(node);
    if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter)) return null;
    const decl = type.getSymbol()?.declarations?.[0];
    if (decl?.getSourceFile().fileName.includes('/node_modules/mysql2/')) return null;
    return type;
}

function connect(): mysql.Connection {
    const { host, port, database, user, password } = connectionOptions();
    return mysql.createConnection({ host, port, database, user, password });
}

/**
 * mysql2 interpole les `?` côté client : un SELECT et un GROUP BY qui portent
 * la même expression paramétrée y deviennent identiques, ce que la préparation
 * ne voit pas (`only_full_group_by`). On repasse alors avec les `?` remplacés.
 */
async function prepare(
    conn: mysql.Connection,
    text: string,
    schema: ReadonlyMap<string, SchemaColumn>
): Promise<PrepareResult> {
    const { sql, folded } = expandBulkValues(text);
    const first = await prepareOnce(conn, sql, folded, schema);
    if (!('error' in first) || first.code !== 'ER_WRONG_FIELD_WITH_GROUP') return first;
    const { sql: inlined, count } = inlinePlaceholders(sql);
    const second = await prepareOnce(conn, inlined, 0, schema);
    return 'error' in second ? first : { ok: { ...second.ok, parameters: count - folded } };
}

function prepareOnce(
    conn: mysql.Connection,
    sql: string,
    folded: number,
    schema: ReadonlyMap<string, SchemaColumn>
): Promise<PrepareResult> {
    return new Promise((resolve) => {
        conn.prepare(sql, (err, statement) => {
            if (err) {
                resolve({ error: err.message, code: err.code });
                return;
            }
            const raw = statement as unknown as { columns?: PreparedColumn[]; parameters?: unknown[] };
            const columns = raw.columns ?? [];
            const parameters = (raw.parameters?.length ?? 0) - folded;
            statement.close();
            conn.unprepare(sql);
            const ctx = nullContext(sql);
            resolve({ ok: { columns: columns.map((c) => columnShape(c, schema, ctx)), parameters } });
        });
    });
}

interface ColumnInfo {
    TABLE_NAME: string;
    COLUMN_NAME: string;
    DATA_TYPE: string;
    COLUMN_TYPE: string;
    IS_NULLABLE: 'YES' | 'NO';
}

function loadSchema(conn: mysql.Connection): Promise<Map<string, SchemaColumn>> {
    return new Promise((resolve, reject) => {
        conn.query(
            `SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE, COLUMN_TYPE, IS_NULLABLE FROM INFORMATION_SCHEMA.COLUMNS
              WHERE TABLE_SCHEMA = DATABASE()`,
            (err, rows) => {
                if (err) return reject(err);
                const map = new Map<string, SchemaColumn>();
                for (const r of rows as ColumnInfo[]) {
                    map.set(`${r.TABLE_NAME}.${r.COLUMN_NAME}`, {
                        nullable: r.IS_NULLABLE === 'YES',
                        ...(r.DATA_TYPE === 'enum' ? { enumValues: enumValues(r.COLUMN_TYPE) } : {})
                    });
                }
                resolve(map);
            }
        );
    });
}

function hint(code: string): string {
    return code === 'ER_NO_SUCH_TABLE' ? ' (base pas migrée ? lancez le serveur ou le smoke)' : '';
}

/** Les écarts entre le type de ligne et les colonnes que rend une variante de la requête. */
function rowProblems(type: ts.Type, columns: ColumnShape[], checker: ts.TypeChecker): string[] {
    const byName = new Map(columns.map((c) => [c.name, c]));
    const problems: string[] = [];
    for (const prop of checker.getPropertiesOfType(type)) {
        const optional = (prop.flags & ts.SymbolFlags.Optional) !== 0;
        const col = byName.get(prop.name);
        if (!col) {
            if (!optional) problems.push(`« ${prop.name} » n'est pas une colonne du résultat`);
            continue;
        }
        const reason = misfit(col, fieldShape(checker.getTypeOfSymbol(prop), checker));
        if (reason) problems.push(`« ${prop.name} » : ${reason}`);
    }
    return problems;
}

async function main(): Promise<void> {
    const program = loadProgram(ROOT);
    const checker = program.getTypeChecker();
    const conn = connect();
    let schema: Map<string, SchemaColumn>;
    try {
        schema = await loadSchema(conn);
    } catch (err) {
        console.error(`check-queries: connexion à la base impossible (variables DB_* ?) : ${(err as Error).message}`);
        process.exit(1);
    }

    const scope = { program, conn, root: ROOT, workspace: WORKSPACE, verbose: VERBOSE };
    if (SCOPE_REPORT) {
        await scopePass({ ...scope, report: true });
        conn.end();
        return;
    }

    const cache = new Map<string, PrepareResult>();
    const problems: Problem[] = [];
    const dynamic: string[] = [];
    const stats = { calls: 0, checked: 0, ignored: 0 };

    const checkCall = async (call: ts.CallExpression): Promise<void> => {
        stats.calls++;
        const at = whereOf(call, WORKSPACE);
        const reason = ignoreReason(call);
        if (reason !== null) {
            if (reason === '') problems.push({ where: at, message: '`check-queries: ignore` sans raison' });
            stats.ignored++;
            return;
        }
        const sqlArg = call.arguments[0];
        let variants: string[];
        try {
            variants = sqlVariants(sqlArg, checker);
        } catch (err) {
            if (!(err instanceof DynamicSql)) throw err;
            const culprit = err.node ? err.node.getText().replace(/\s+/g, ' ').slice(0, 60) : 'trop de variantes';
            dynamic.push(`${at}  ${culprit}`);
            return;
        }
        stats.checked++;
        const type = rowType(call, checker);
        const given = paramCount(call);
        let maxPlaceholders = -1;
        for (const sql of variants) {
            let result = cache.get(sql);
            if (!result) {
                result = await prepare(conn, sql, schema);
                cache.set(sql, result);
            }
            const label = variants.length > 1 ? ` [variante : ${sql.replace(/\s+/g, ' ').slice(0, 80)}]` : '';
            if ('error' in result) {
                problems.push({ where: at, message: `${result.error}${hint(result.code)}${label}` });
                continue;
            }
            const { columns, parameters } = result.ok;
            maxPlaceholders = Math.max(maxPlaceholders, parameters);
            if (given !== null && parameters > given) {
                problems.push({ where: at, message: `${parameters} « ? » pour ${given} paramètre(s)${label}` });
            }
            if (!type) continue;
            const found =
                columns.length === 0
                    ? ['la requête ne rend aucune colonne, le type de ligne en attend']
                    : rowProblems(type, columns, checker);
            for (const p of found) problems.push({ where: at, message: `${p}${label}` });
        }
        if (given !== null && maxPlaceholders >= 0 && given > maxPlaceholders) {
            problems.push({ where: at, message: `${given} paramètre(s) pour ${maxPlaceholders} « ? » au plus` });
        }
    };

    const calls = findQueryCalls(program, WORKSPACE);
    for (const call of calls) await checkCall(call);
    const unbounded = await scopePass({ ...scope, report: false });
    conn.end();

    const seen = new Set<string>();
    const unique = problems.filter((p) => {
        const key = `${p.where} ${p.message}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
    for (const p of unique) console.error(`✗ ${p.where}  ${p.message}`);
    if (VERBOSE) for (const d of dynamic) console.log(`  dynamique  ${d}`);
    console.log(
        `check-queries: ${stats.calls} appel(s), ${stats.checked} préparé(s), ` +
            `${dynamic.length} dynamique(s)${VERBOSE ? '' : ' (--verbose les liste)'}, ${stats.ignored} écarté(s)`
    );
    if (unique.length > 0) console.error(`check-queries: ${unique.length} écart(s) entre le code et la base`);
    if (unbounded > 0) {
        console.error(
            `check-queries: ${unbounded} faute(s) de cloisonnement (--scope-report --verbose les détaille, Docs/CREATING_A_FEATURE.md dit quoi en faire)`
        );
    }
    if (unique.length + unbounded > 0) process.exit(1);
}

void main();
