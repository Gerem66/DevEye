import mysql from 'mysql2/promise';
import { Client as PgClient, types as pgTypes, type CustomTypesConfig } from 'pg';
import type {
    DatabaseCell,
    DatabaseEngine,
    DatabaseFilter,
    DatabaseIdRange,
    DatabaseRows,
    DatabaseSort,
    DatabaseStructure,
    DatabaseTable
} from '../contracts/domain';
import { isRemoteFailure } from '@deveye/types/sdk/server';
import { openTunnel, type TunnelConfig } from './tunnel';

/**
 * Joindre une base, quel que soit son dialecte : deux adaptateurs derrière une
 * seule interface. Une connexion par opération, jamais de pool : une base
 * d'inventaire s'interroge rarement, et un pool tiendrait aussi la session SSH.
 * `assertReadOnly` garde l'intention ; le compte saisi décide en dernier ressort.
 */

const QUERY_TIMEOUT_MS = 15_000;
const CONNECT_TIMEOUT_MS = 12_000;

export const ROWS_PAGE_DEFAULT = 50;

export interface EngineTarget {
    engine: DatabaseEngine;
    host: string;
    port: number;
    database: string;
    username: string;
    password: string | null;
    access: TunnelConfig;
}

/** Ce qu'un relevé apprend d'un serveur. */
export interface Inventory {
    serverVersion: string;
    sizeBytes: number | null;
    tableCount: number;
}

/** Des plages sur une colonne, bornes comprises ; colonne validée par l'appelant. */
export interface IdRanges {
    column: string;
    ranges: DatabaseIdRange[];
}

export interface PageRequest {
    offset: number;
    limit: number;
    /** Critères de recherche ; colonnes validées par l'appelant. */
    filters?: DatabaseFilter[];
    /** `and` par défaut. */
    combinator?: 'and' | 'or';
    sort?: DatabaseSort;
    /** Bornes sur une colonne, ajoutées par un ET aux critères. */
    ranges?: IdRanges;
}

/** Ce qu'une instruction libre a produit : des lignes, ou un décompte. */
export interface ExecutionResult {
    rows: DatabaseRows | null;
    affected: number | null;
    elapsedMs: number;
}

/**
 * Une session ouverte sur une base. Aucun nom n'est validé ici : table et
 * colonnes arrivent confrontées au catalogue par `explore.ts`, la session cite.
 */
export interface Session {
    serverVersion(): Promise<string>;
    inventory(): Promise<Inventory>;
    tables(): Promise<DatabaseTable[]>;
    structure(schema: string, table: string): Promise<DatabaseStructure>;
    tableRows(schema: string, table: string, page: PageRequest): Promise<DatabaseRows>;
    /** Lecture seule (`assertReadOnly`). */
    query(sql: string): Promise<DatabaseRows>;
    /** Une instruction libre, écriture comprise (le terminal). */
    execute(sql: string): Promise<ExecutionResult>;
    insertRow(schema: string, table: string, values: DatabaseCell[]): Promise<number>;
    updateRow(schema: string, table: string, key: DatabaseCell[], values: DatabaseCell[]): Promise<number>;
    deleteRows(schema: string, table: string, keys: DatabaseCell[][]): Promise<number>;
    close(): Promise<void>;
}

/**
 * Les types temporels de Postgres, laissés en texte tel que le serveur les
 * rend : voir `dateStrings` côté MySQL, même raison.
 */
const PG_TEMPORAL_OIDS = new Set([
    pgTypes.builtins.DATE,
    pgTypes.builtins.TIME,
    pgTypes.builtins.TIMETZ,
    pgTypes.builtins.TIMESTAMP,
    pgTypes.builtins.TIMESTAMPTZ
]);

const pgTextDates: CustomTypesConfig = {
    getTypeParser: (oid, format) =>
        PG_TEMPORAL_OIDS.has(oid) && format !== 'binary' ? (value: string) => value : pgTypes.getTypeParser(oid, format)
};

/** Tout en chaîne au transport, pour ne rien perdre (`BIGINT`, binaires). */
function toText(value: unknown): string | null {
    if (value === null || value === undefined) return null;
    if (Buffer.isBuffer(value)) return `0x${value.subarray(0, 32).toString('hex')}${value.length > 32 ? '…' : ''}`;
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
}

/**
 * Ce qui distingue les deux moteurs dans une requête : citer un identifiant et
 * désigner un paramètre. Tout le reste s'écrit une fois pour les deux.
 */
interface Dialect {
    quote(identifier: string): string;
    /** Le marqueur du n-ième paramètre (1-indexé). */
    param(index: number): string;
}

const MYSQL: Dialect = {
    quote: (id) => `\`${id.replace(/`/g, '``')}\``,
    param: () => '?'
};

const POSTGRES: Dialect = {
    quote: (id) => `"${id.replace(/"/g, '""')}"`,
    param: (i) => `$${i}`
};

/**
 * Les valeurs liées d'une requête. Un compteur partagé, parce que PostgreSQL
 * numérote ses marqueurs : `WHERE`, ordre et fenêtre puisent dans la même suite.
 */
class Params {
    readonly values: unknown[] = [];
    constructor(private readonly dialect: Dialect) {}
    add(value: unknown): string {
        this.values.push(value);
        return this.dialect.param(this.values.length);
    }
}

/**
 * La clause `WHERE` d'une recherche : opérateur d'une énumération fermée,
 * valeur toujours liée, colonne confrontée au catalogue par l'appelant.
 * Les jokers d'un `LIKE` (`%`, `_`, `\%`) gardent leur sens, à dessein : la
 * valeur reste liée, seul son sens pour `LIKE` change.
 */
function buildWhere(
    d: Dialect,
    p: Params,
    filters: DatabaseFilter[] = [],
    combinator: 'and' | 'or' = 'and',
    ranges?: IdRanges
): string {
    const grouped = buildRanges(d, p, ranges);
    if (filters.length === 0) return grouped === '' ? '' : ` WHERE ${grouped}`;
    const parts = filters.map((f) => {
        const col = d.quote(f.column);
        switch (f.operator) {
            case 'isNull':
                return `${col} IS NULL`;
            case 'notNull':
                return `${col} IS NOT NULL`;
            case 'ne':
                return `${col} <> ${p.add(f.value)}`;
            case 'gt':
                return `${col} > ${p.add(f.value)}`;
            case 'gte':
                return `${col} >= ${p.add(f.value)}`;
            case 'lt':
                return `${col} < ${p.add(f.value)}`;
            case 'lte':
                return `${col} <= ${p.add(f.value)}`;
            case 'contains':
                return `${col} LIKE ${p.add(`%${f.value}%`)}`;
            case 'starts':
                return `${col} LIKE ${p.add(`${f.value}%`)}`;
            case 'ends':
                return `${col} LIKE ${p.add(`%${f.value}`)}`;
            case 'eq':
                return `${col} = ${p.add(f.value)}`;
            default:
                // Inatteignable tant que tous les membres de l'énumération sont
                // traités ci-dessus.
                throw new Error('Opérateur de recherche inconnu.');
        }
    });
    // Les plages bornent la sélection par un ET, quelle que soit la
    // combinaison des critères : un `OU` reste parenthésé à part.
    const clause = parts.join(combinator === 'or' ? ' OR ' : ' AND ');
    return grouped === '' ? ` WHERE ${clause}` : ` WHERE (${clause}) AND ${grouped}`;
}

/** Des `BETWEEN` reliés par `OU`, bornes liées ; colonne résolue par l'appelant. */
function buildRanges(d: Dialect, p: Params, ranges?: IdRanges): string {
    if (!ranges || ranges.ranges.length === 0) return '';
    const col = d.quote(ranges.column);
    const parts = ranges.ranges.map((r) => `${col} BETWEEN ${p.add(r.from)} AND ${p.add(r.to)}`);
    return `(${parts.join(' OR ')})`;
}

/** La clause `ORDER BY`, colonne déjà validée par l'appelant. */
function buildOrder(d: Dialect, sort?: DatabaseSort): string {
    if (!sort) return '';
    return ` ORDER BY ${d.quote(sort.column)} ${sort.direction === 'desc' ? 'DESC' : 'ASC'}`;
}

/** La condition qui désigne une ligne par sa clé ; `IS NULL` et non `= NULL`, qui ne vaut jamais vrai. */
function keyCondition(d: Dialect, p: Params, key: DatabaseCell[]): string {
    return key
        .map((cell) =>
            cell.value === null ? `${d.quote(cell.column)} IS NULL` : `${d.quote(cell.column)} = ${p.add(cell.value)}`
        )
        .join(' AND ');
}

interface StructureRows {
    schema: string;
    table: string;
    columns: DatabaseStructure['columns'];
    primaryKey: string[];
    /** Une ligne par colonne de contrainte, déjà ordonnée par position. */
    foreignRows: { name: string; column: string; refSchema: string; refTable: string; refColumn: string }[];
    /** Une ligne par colonne d'index, déjà ordonnée. */
    indexRows: { name: string; column: string; unique: boolean }[];
}

/** Regroupe les lignes du catalogue (une par colonne de contrainte) en contraintes et index. */
function buildStructure(input: StructureRows): DatabaseStructure {
    const foreignKeys = new Map<string, DatabaseStructure['foreignKeys'][number]>();
    for (const row of input.foreignRows) {
        const existing = foreignKeys.get(row.name);
        if (existing) {
            existing.columns.push(row.column);
            existing.refColumns.push(row.refColumn);
        } else {
            foreignKeys.set(row.name, {
                name: row.name,
                columns: [row.column],
                refSchema: row.refSchema,
                refTable: row.refTable,
                refColumns: [row.refColumn]
            });
        }
    }

    const indexes = new Map<string, DatabaseStructure['indexes'][number]>();
    for (const row of input.indexRows) {
        const existing = indexes.get(row.name);
        if (existing) existing.columns.push(row.column);
        else indexes.set(row.name, { name: row.name, columns: [row.column], unique: row.unique });
    }

    return {
        schema: input.schema,
        table: input.table,
        columns: input.columns,
        primaryKey: input.primaryKey,
        foreignKeys: [...foreignKeys.values()],
        indexes: [...indexes.values()]
    };
}

/**
 * Refuse tout ce qui n'est pas une lecture unique. Le point-virgule interne est
 * refusé : c'est le seul cas où une chaîne qui commence par SELECT peut écrire.
 */
export function assertReadOnly(sql: string): void {
    const trimmed = sql.trim().replace(/;\s*$/, '');
    if (trimmed === '') throw new Error('La requête est vide.');
    if (trimmed.includes(';')) {
        throw new Error(
            'Une seule instruction à la fois : le point-virgule n’est pas accepté au milieu d’une requête.'
        );
    }
    if (!/^(select|with|show|explain)\b/i.test(trimmed)) {
        throw new Error('Seules les requêtes de lecture sont acceptées (SELECT, WITH, SHOW, EXPLAIN).');
    }
}

/**
 * Refuse ce qui n'est pas une seule instruction, écriture comprise : un
 * copier-coller de trois instructions ne doit pas s'exécuter en entier.
 */
export function assertSingleStatement(sql: string): void {
    const trimmed = sql.trim().replace(/;\s*$/, '');
    if (trimmed === '') throw new Error('L’instruction est vide.');
    if (trimmed.includes(';')) {
        throw new Error(
            'Une seule instruction à la fois : le point-virgule n’est pas accepté au milieu d’une instruction.'
        );
    }
}

/** La valeur numérique d'une condition d'alerte : un seul nombre, ou une erreur claire plutôt qu'un `NaN`. */
export function singleNumber(rows: DatabaseRows): number {
    if (rows.rows.length === 0) throw new Error('La requête n’a rendu aucune ligne.');
    if (rows.rows.length > 1)
        throw new Error(`La requête a rendu ${rows.rows.length} lignes ; il en faut exactement une.`);
    const first = rows.rows[0];
    if (first.length !== 1) throw new Error(`La requête a rendu ${first.length} colonnes ; il en faut exactement une.`);
    const raw = first[0];
    if (raw === null) throw new Error('La requête a rendu une valeur nulle.');
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new Error(`« ${raw} » n’est pas un nombre.`);
    return value;
}

/** Ouvre une session, tunnel compris. Toujours refermée par `close()`. */
export async function openSession(target: EngineTarget): Promise<Session> {
    const tunnel = await openTunnel(target.access, { host: target.host, port: target.port });
    try {
        return target.engine === 'postgres' ? await openPostgres(target, tunnel) : await openMysql(target, tunnel);
    } catch (e) {
        // Le tunnel est ouvert, la session non : sans ce rattrapage il
        // resterait un écouteur et une session SSH derrière chaque échec.
        await tunnel.close();
        throw e;
    }
}

async function openMysql(target: EngineTarget, tunnel: { host: string; port: number; close: () => Promise<void> }) {
    const connection = await mysql.createConnection({
        host: tunnel.host,
        port: tunnel.port,
        user: target.username,
        password: target.password ?? undefined,
        database: target.database,
        connectTimeout: CONNECT_TIMEOUT_MS,
        // Les entiers hors du domaine sûr reviennent en chaîne plutôt
        // qu'arrondis en silence.
        supportBigNumbers: true,
        bigNumberStrings: true,
        // Les dates restent le texte que le serveur rend (`2026-09-15 18:28:17`) :
        // en objet `Date`, le pilote les lirait dans le fuseau du processus et
        // l'écran les montrerait décalées en UTC, sous une forme ISO que MySQL
        // refuse à la réécriture d'une ligne.
        dateStrings: true,
        multipleStatements: false
    });

    const run = async (sql: string, params: unknown[] = []): Promise<DatabaseRows> => {
        const started = Date.now();
        const [rows, fields] = await connection.query({ sql, values: params, timeout: QUERY_TIMEOUT_MS });
        const list = Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
        const columns = (fields ?? []).map((f) => f.name);
        return {
            columns,
            rows: list.map((row: Record<string, unknown>) => columns.map((c) => toText(row[c]))),
            total: null,
            elapsedMs: Date.now() - started
        };
    };

    const exec = async (sql: string, params: unknown[] = []): Promise<number> => {
        const [result] = await connection.query({ sql, values: params, timeout: QUERY_TIMEOUT_MS });
        return Number((result as unknown as { affectedRows?: number }).affectedRows ?? 0);
    };

    const session: Session = {
        async serverVersion() {
            const res = await run('SELECT VERSION() AS v');
            return res.rows[0]?.[0] ?? 'inconnue';
        },
        async inventory() {
            const version = await session.serverVersion();
            const res = await run(
                `SELECT COUNT(*) AS tables_count, COALESCE(SUM(data_length + index_length), 0) AS size_bytes
                   FROM information_schema.TABLES
                  WHERE TABLE_SCHEMA = ?`,
                [target.database]
            );
            const row = res.rows[0] ?? [];
            return {
                serverVersion: version,
                sizeBytes: row[1] === null || row[1] === undefined ? null : Number(row[1]),
                tableCount: Number(row[0] ?? 0)
            };
        },
        async tables() {
            const res = await run(
                `SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_ROWS, (data_length + index_length) AS size_bytes
                   FROM information_schema.TABLES
                  WHERE TABLE_SCHEMA = ?
                  ORDER BY TABLE_NAME ASC`,
                [target.database]
            );
            return res.rows.map((row) => ({
                schema: row[0] ?? '',
                name: row[1] ?? '',
                rowCount: row[2] === null ? null : Number(row[2]),
                sizeBytes: row[3] === null ? null : Number(row[3])
            }));
        },
        async structure(schema, table) {
            const columns = await run(
                `SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_KEY, EXTRA, COLUMN_COMMENT
                   FROM information_schema.COLUMNS
                  WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
                  ORDER BY ORDINAL_POSITION ASC`,
                [schema, table]
            );
            // La clé primaire dans l'ordre de la clé, pas celui des colonnes.
            const primary = await run(
                `SELECT COLUMN_NAME FROM information_schema.STATISTICS
                  WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME = 'PRIMARY'
                  ORDER BY SEQ_IN_INDEX ASC`,
                [schema, table]
            );
            const foreign = await run(
                `SELECT CONSTRAINT_NAME, COLUMN_NAME, REFERENCED_TABLE_SCHEMA, REFERENCED_TABLE_NAME,
                        REFERENCED_COLUMN_NAME
                   FROM information_schema.KEY_COLUMN_USAGE
                  WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND REFERENCED_TABLE_NAME IS NOT NULL
                  ORDER BY CONSTRAINT_NAME ASC, ORDINAL_POSITION ASC`,
                [schema, table]
            );
            const indexes = await run(
                `SELECT INDEX_NAME, COLUMN_NAME, NON_UNIQUE FROM information_schema.STATISTICS
                  WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME <> 'PRIMARY'
                  ORDER BY INDEX_NAME ASC, SEQ_IN_INDEX ASC`,
                [schema, table]
            );

            return buildStructure({
                schema,
                table,
                columns: columns.rows.map((r) => ({
                    name: r[0] ?? '',
                    type: r[1] ?? '',
                    nullable: r[2] === 'YES',
                    default: r[3],
                    primaryKey: r[4] === 'PRI',
                    // `auto_increment` et colonnes calculées : le moteur refuse
                    // qu'on les renseigne.
                    generated: /auto_increment|GENERATED/i.test(r[5] ?? ''),
                    comment: r[6] ?? ''
                })),
                primaryKey: primary.rows.map((r) => r[0] ?? ''),
                foreignRows: foreign.rows.map((r) => ({
                    name: r[0] ?? '',
                    column: r[1] ?? '',
                    refSchema: r[2] ?? '',
                    refTable: r[3] ?? '',
                    refColumn: r[4] ?? ''
                })),
                indexRows: indexes.rows.map((r) => ({
                    name: r[0] ?? '',
                    column: r[1] ?? '',
                    unique: r[2] === '0'
                }))
            });
        },
        async tableRows(schema, table, page) {
            const quoted = `${MYSQL.quote(schema)}.${MYSQL.quote(table)}`;
            const countParams = new Params(MYSQL);
            const where = buildWhere(MYSQL, countParams, page.filters, page.combinator, page.ranges);
            const count = await run(`SELECT COUNT(*) AS n FROM ${quoted}${where}`, countParams.values);

            // Une seconde suite de paramètres pour la seconde requête.
            const pageParams = new Params(MYSQL);
            const sql =
                `SELECT * FROM ${quoted}` +
                buildWhere(MYSQL, pageParams, page.filters, page.combinator, page.ranges) +
                buildOrder(MYSQL, page.sort) +
                ` LIMIT ${pageParams.add(page.limit)} OFFSET ${pageParams.add(page.offset)}`;
            const rows = await run(sql, pageParams.values);
            return { ...rows, total: Number(count.rows[0]?.[0] ?? 0) };
        },
        async query(sql) {
            assertReadOnly(sql);
            return run(sql);
        },
        async execute(sql) {
            assertSingleStatement(sql);
            const started = Date.now();
            const [result, fields] = await connection.query({ sql, timeout: QUERY_TIMEOUT_MS });
            // Un jeu de résultats arrive en tableau ; une écriture rend un
            // en-tête portant son décompte.
            if (Array.isArray(result)) {
                const columns = (fields ?? []).map((f) => f.name);
                const list = result as Record<string, unknown>[];
                return {
                    rows: {
                        columns,
                        rows: list.map((row) => columns.map((c) => toText(row[c]))),
                        total: null,
                        elapsedMs: Date.now() - started
                    },
                    affected: null,
                    elapsedMs: Date.now() - started
                };
            }
            const header = result as unknown as { affectedRows?: number };
            return { rows: null, affected: Number(header.affectedRows ?? 0), elapsedMs: Date.now() - started };
        },
        async insertRow(schema, table, values) {
            const p = new Params(MYSQL);
            const columns = values.map((v) => MYSQL.quote(v.column)).join(', ');
            const markers = values.map((v) => p.add(v.value)).join(', ');
            return exec(
                `INSERT INTO ${MYSQL.quote(schema)}.${MYSQL.quote(table)} (${columns}) VALUES (${markers})`,
                p.values
            );
        },
        async updateRow(schema, table, key, values) {
            const p = new Params(MYSQL);
            const sets = values.map((v) => `${MYSQL.quote(v.column)} = ${p.add(v.value)}`).join(', ');
            const where = keyCondition(MYSQL, p, key);
            return exec(`UPDATE ${MYSQL.quote(schema)}.${MYSQL.quote(table)} SET ${sets} WHERE ${where}`, p.values);
        },
        async deleteRows(schema, table, keys) {
            const p = new Params(MYSQL);
            const where = keys.map((k) => `(${keyCondition(MYSQL, p, k)})`).join(' OR ');
            return exec(`DELETE FROM ${MYSQL.quote(schema)}.${MYSQL.quote(table)} WHERE ${where}`, p.values);
        },
        async close() {
            try {
                await connection.end();
            } finally {
                await tunnel.close();
            }
        }
    };
    return session;
}

async function openPostgres(target: EngineTarget, tunnel: { host: string; port: number; close: () => Promise<void> }) {
    const client = new PgClient({
        host: tunnel.host,
        port: tunnel.port,
        user: target.username,
        password: target.password ?? undefined,
        database: target.database,
        connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
        query_timeout: QUERY_TIMEOUT_MS,
        statement_timeout: QUERY_TIMEOUT_MS,
        types: pgTextDates
    });
    await client.connect();

    const run = async (sql: string, params: unknown[] = []): Promise<DatabaseRows> => {
        const started = Date.now();
        const res = await client.query({ text: sql, values: params, rowMode: 'array' });
        const columns = res.fields.map((f) => f.name);
        const rows = (res.rows as unknown[][]) ?? [];
        return {
            columns,
            rows: rows.map((row: unknown[]) => row.map(toText)),
            total: null,
            elapsedMs: Date.now() - started
        };
    };

    const exec = async (sql: string, params: unknown[] = []): Promise<number> => {
        const res = await client.query({ text: sql, values: params });
        return Number(res.rowCount ?? 0);
    };

    const session: Session = {
        async serverVersion() {
            const res = await run('SELECT version()');
            return res.rows[0]?.[0] ?? 'inconnue';
        },
        async inventory() {
            const version = await session.serverVersion();
            const res = await run(
                `SELECT (SELECT COUNT(*) FROM information_schema.tables
                          WHERE table_schema NOT IN ('pg_catalog', 'information_schema')) AS tables_count,
                        pg_database_size(current_database()) AS size_bytes`
            );
            const row = res.rows[0] ?? [];
            return {
                serverVersion: version,
                sizeBytes: row[1] === null || row[1] === undefined ? null : Number(row[1]),
                tableCount: Number(row[0] ?? 0)
            };
        },
        async tables() {
            // `reltuples` est l'estimation du planificateur ; `-1` signifie
            // « jamais analysée », rendu en `null`.
            const res = await run(
                `SELECT n.nspname, c.relname,
                        CASE WHEN c.reltuples < 0 THEN NULL ELSE c.reltuples::bigint END AS row_count,
                        pg_total_relation_size(c.oid) AS size_bytes
                   FROM pg_class c
                   JOIN pg_namespace n ON n.oid = c.relnamespace
                  WHERE c.relkind IN ('r', 'p')
                    AND n.nspname NOT IN ('pg_catalog', 'information_schema')
                  ORDER BY n.nspname ASC, c.relname ASC`
            );
            return res.rows.map((row) => ({
                schema: row[0] ?? '',
                name: row[1] ?? '',
                rowCount: row[2] === null ? null : Number(row[2]),
                sizeBytes: row[3] === null ? null : Number(row[3])
            }));
        },
        async structure(schema, table) {
            // `format('%I.%I', …)::regclass` cite les identifiants côté serveur :
            // la table est désignée par un paramètre lié.
            const relation = `format('%I.%I', $1::text, $2::text)::regclass`;
            const columns = await run(
                `SELECT a.attname,
                        format_type(a.atttypid, a.atttypmod) AS type,
                        NOT a.attnotnull AS nullable,
                        pg_get_expr(d.adbin, d.adrelid) AS default_expr,
                        COALESCE(bool_or(i.indisprimary), false) AS is_primary,
                        (a.attidentity <> '' OR a.attgenerated <> ''
                         OR COALESCE(pg_get_expr(d.adbin, d.adrelid), '') LIKE 'nextval(%') AS generated,
                        COALESCE(col_description(a.attrelid, a.attnum), '') AS comment
                   FROM pg_attribute a
                   LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
                   LEFT JOIN pg_index i ON i.indrelid = a.attrelid AND i.indisprimary
                                       AND a.attnum = ANY(i.indkey)
                  WHERE a.attrelid = ${relation} AND a.attnum > 0 AND NOT a.attisdropped
                  GROUP BY a.attname, a.atttypid, a.atttypmod, a.attnotnull, d.adbin, d.adrelid,
                           a.attidentity, a.attgenerated, a.attrelid, a.attnum
                  ORDER BY a.attnum ASC`,
                [schema, table]
            );
            // La clé primaire dans l'ordre de la clé, que porte `indkey`.
            const primary = await run(
                `SELECT att.attname
                   FROM pg_index i
                   CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
                   JOIN pg_attribute att ON att.attrelid = i.indrelid AND att.attnum = k.attnum
                  WHERE i.indrelid = ${relation} AND i.indisprimary
                  ORDER BY k.ord ASC`,
                [schema, table]
            );
            // `unnest(conkey, confkey)` apparie les deux côtés position par
            // position ; une jointure sur `constraint_column_usage` produirait
            // un produit croisé.
            const foreign = await run(
                `SELECT con.conname, att.attname, nsp2.nspname, cls2.relname, att2.attname
                   FROM pg_constraint con
                   CROSS JOIN LATERAL unnest(con.conkey, con.confkey) WITH ORDINALITY AS u(k, fk, ord)
                   JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = u.k
                   JOIN pg_attribute att2 ON att2.attrelid = con.confrelid AND att2.attnum = u.fk
                   JOIN pg_class cls2 ON cls2.oid = con.confrelid
                   JOIN pg_namespace nsp2 ON nsp2.oid = cls2.relnamespace
                  WHERE con.contype = 'f' AND con.conrelid = ${relation}
                  ORDER BY con.conname ASC, u.ord ASC`,
                [schema, table]
            );
            const indexes = await run(
                `SELECT cls.relname, att.attname, i.indisunique
                   FROM pg_index i
                   JOIN pg_class cls ON cls.oid = i.indexrelid
                   CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
                   JOIN pg_attribute att ON att.attrelid = i.indrelid AND att.attnum = k.attnum
                  WHERE i.indrelid = ${relation} AND NOT i.indisprimary
                  ORDER BY cls.relname ASC, k.ord ASC`,
                [schema, table]
            );

            return buildStructure({
                schema,
                table,
                columns: columns.rows.map((r) => ({
                    name: r[0] ?? '',
                    type: r[1] ?? '',
                    nullable: r[2] === 'true',
                    default: r[3],
                    primaryKey: r[4] === 'true',
                    generated: r[5] === 'true',
                    comment: r[6] ?? ''
                })),
                primaryKey: primary.rows.map((r) => r[0] ?? ''),
                foreignRows: foreign.rows.map((r) => ({
                    name: r[0] ?? '',
                    column: r[1] ?? '',
                    refSchema: r[2] ?? '',
                    refTable: r[3] ?? '',
                    refColumn: r[4] ?? ''
                })),
                indexRows: indexes.rows.map((r) => ({
                    name: r[0] ?? '',
                    column: r[1] ?? '',
                    unique: r[2] === 'true'
                }))
            });
        },
        async tableRows(schema, table, page) {
            const quoted = `${POSTGRES.quote(schema)}.${POSTGRES.quote(table)}`;
            const countParams = new Params(POSTGRES);
            const where = buildWhere(POSTGRES, countParams, page.filters, page.combinator, page.ranges);
            const count = await run(`SELECT COUNT(*) FROM ${quoted}${where}`, countParams.values);

            const pageParams = new Params(POSTGRES);
            const sql =
                `SELECT * FROM ${quoted}` +
                buildWhere(POSTGRES, pageParams, page.filters, page.combinator, page.ranges) +
                buildOrder(POSTGRES, page.sort) +
                ` LIMIT ${pageParams.add(page.limit)} OFFSET ${pageParams.add(page.offset)}`;
            const rows = await run(sql, pageParams.values);
            return { ...rows, total: Number(count.rows[0]?.[0] ?? 0) };
        },
        async query(sql) {
            assertReadOnly(sql);
            return run(sql);
        },
        async execute(sql) {
            assertSingleStatement(sql);
            const started = Date.now();
            const res = await client.query({ text: sql, rowMode: 'array' });
            // La présence de colonnes distingue une lecture d'une écriture :
            // `rowCount` est renseigné dans les deux cas.
            if (res.fields.length > 0) {
                const columns = res.fields.map((f) => f.name);
                const rows = (res.rows as unknown[][]) ?? [];
                return {
                    rows: {
                        columns,
                        rows: rows.map((row) => row.map(toText)),
                        total: null,
                        elapsedMs: Date.now() - started
                    },
                    affected: null,
                    elapsedMs: Date.now() - started
                };
            }
            return { rows: null, affected: Number(res.rowCount ?? 0), elapsedMs: Date.now() - started };
        },
        async insertRow(schema, table, values) {
            const p = new Params(POSTGRES);
            const columns = values.map((v) => POSTGRES.quote(v.column)).join(', ');
            const markers = values.map((v) => p.add(v.value)).join(', ');
            return exec(
                `INSERT INTO ${POSTGRES.quote(schema)}.${POSTGRES.quote(table)} (${columns}) VALUES (${markers})`,
                p.values
            );
        },
        async updateRow(schema, table, key, values) {
            const p = new Params(POSTGRES);
            const sets = values.map((v) => `${POSTGRES.quote(v.column)} = ${p.add(v.value)}`).join(', ');
            const where = keyCondition(POSTGRES, p, key);
            return exec(
                `UPDATE ${POSTGRES.quote(schema)}.${POSTGRES.quote(table)} SET ${sets} WHERE ${where}`,
                p.values
            );
        },
        async deleteRows(schema, table, keys) {
            const p = new Params(POSTGRES);
            const where = keys.map((k) => `(${keyCondition(POSTGRES, p, k)})`).join(' OR ');
            return exec(`DELETE FROM ${POSTGRES.quote(schema)}.${POSTGRES.quote(table)} WHERE ${where}`, p.values);
        },
        async close() {
            try {
                await client.end();
            } finally {
                await tunnel.close();
            }
        }
    };
    return session;
}

const DRIVER_FAILURES: Record<string, string> = {
    ECONNREFUSED: 'Connexion refusée : rien n’écoute sur cet hôte et ce port.',
    ETIMEDOUT: 'Le serveur n’a pas répondu dans le délai imparti.',
    ESOCKETTIMEDOUT: 'Le serveur n’a pas répondu dans le délai imparti.',
    ENOTFOUND: 'Hôte introuvable : le nom ne se résout pas.',
    EAI_AGAIN: 'Hôte introuvable : le nom ne se résout pas.',
    ER_ACCESS_DENIED_ERROR: 'Identifiants refusés par le serveur.',
    '28P01': 'Identifiants refusés par le serveur.',
    '28000': 'Identifiants refusés par le serveur.',
    ER_BAD_DB_ERROR: 'Cette base n’existe pas sur le serveur.',
    '3D000': 'Cette base n’existe pas sur le serveur.',
    ER_DBACCESS_DENIED_ERROR: 'Ce compte n’a pas le droit de lire cette base.',
    '42501': 'Ce compte n’a pas le droit de lire cette base.',
    PROTOCOL_CONNECTION_LOST: 'La connexion a été coupée par le serveur.'
};

function driverCode(e: unknown): string {
    return typeof e === 'object' && e !== null && 'code' in e ? String((e as { code: unknown }).code) : '';
}

/** Traduit l'échec d'un pilote en une phrase corrigeable ; le message brut reste aux journaux. */
export function explainError(e: unknown): string {
    const code = driverCode(e);
    if (Object.hasOwn(DRIVER_FAILURES, code)) return DRIVER_FAILURES[code];
    return (e instanceof Error ? e.message : String(e)) || 'Connexion impossible.';
}

/** L'échec tient au serveur visé (hôte, identifiants, droits), pas à l'instance. */
export function isTargetFailure(e: unknown): boolean {
    return Object.hasOwn(DRIVER_FAILURES, driverCode(e)) || isRemoteFailure(e);
}
