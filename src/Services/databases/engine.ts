import mysql from 'mysql2/promise';
import { Client as PgClient } from 'pg';
import type {
    DatabaseCell,
    DatabaseEngine,
    DatabaseFilter,
    DatabaseRows,
    DatabaseSort,
    DatabaseStructure,
    DatabaseTable
} from 'deveye-types';
import { openTunnel, type TunnelConfig } from './tunnel';

/**
 * Joindre une base, quel que soit son dialecte.
 *
 * Deux adaptateurs derrière une seule interface : tout ce qui est au-dessus —
 * les commandes, le relevé périodique, l'évaluation des alertes — ignore lequel
 * répond. Ajouter un troisième moteur revient à écrire un `EngineAdapter` de
 * plus, sans toucher au reste.
 *
 * ## Une connexion par opération, jamais de pool
 *
 * Une base d'inventaire n'est pas la base de l'application : on l'interroge
 * quelques fois par heure au plus, et souvent jamais. Un pool tiendrait des
 * sockets ouvertes vers des serveurs tiers pour rien, et à travers un tunnel
 * SSH il tiendrait aussi la session SSH. On ouvre, on lit, on ferme.
 *
 * ## Lecture seule, et deux gardes distinctes
 *
 * Les requêtes d'une condition d'alerte, comme celles de l'explorateur, sont du
 * texte écrit par l'utilisateur. Deux protections, qui ne visent pas la même
 * chose :
 *
 *  - {@link assertReadOnly} refuse tout ce qui n'est pas un `SELECT`/`WITH`
 *    unique. C'est une garde d'intention : DevEye n'est pas un client SQL, et
 *    une feature de surveillance n'a pas à écrire ;
 *  - le **compte** utilisé reste celui que l'utilisateur a saisi. C'est lui, et
 *    lui seul, qui décide de ce qui est réellement possible. L'interface le dit
 *    : le bon réflexe est un compte en lecture seule.
 */

/** Au-delà, on abandonne : une requête d'inventaire n'a pas à durer. */
const QUERY_TIMEOUT_MS = 15_000;
const CONNECT_TIMEOUT_MS = 12_000;

/** Lignes rendues par défaut à l'exploration. */
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

/** Comment lire une page de table : filtres, ordre, fenêtre. */
export interface PageRequest {
    offset: number;
    limit: number;
    /** Critères de recherche ; colonnes validées par l'appelant. */
    filters?: DatabaseFilter[];
    /** Comment les filtres se combinent. `and` par défaut. */
    combinator?: 'and' | 'or';
    sort?: DatabaseSort;
}

/** Ce qu'une instruction libre a produit : des lignes, ou un décompte. */
export interface ExecutionResult {
    rows: DatabaseRows | null;
    affected: number | null;
    elapsedMs: number;
}

/**
 * Une session ouverte sur une base, le temps d'une suite d'opérations.
 *
 * **Aucun nom n'est validé ici.** Table et colonnes arrivent déjà confrontées au
 * catalogue réel par l'appelant ({@link ../../features/database/explore}), qui
 * est le seul endroit où cette vérification a du sens : c'est lui qui reçoit ce
 * que le client a envoyé. La session, elle, ne fait que citer.
 */
export interface Session {
    serverVersion(): Promise<string>;
    inventory(): Promise<Inventory>;
    tables(): Promise<DatabaseTable[]>;
    /** Colonnes, clé primaire, clés étrangères et index d'une table. */
    structure(schema: string, table: string): Promise<DatabaseStructure>;
    /** Le contenu d'une table, page par page, filtres et ordre compris. */
    tableRows(schema: string, table: string, page: PageRequest): Promise<DatabaseRows>;
    /** Une requête de lecture, telle que l'utilisateur l'a écrite. */
    query(sql: string): Promise<DatabaseRows>;
    /** Une instruction libre, écriture comprise — le terminal. */
    execute(sql: string): Promise<ExecutionResult>;
    insertRow(schema: string, table: string, values: DatabaseCell[]): Promise<number>;
    updateRow(schema: string, table: string, key: DatabaseCell[], values: DatabaseCell[]): Promise<number>;
    deleteRows(schema: string, table: string, keys: DatabaseCell[][]): Promise<number>;
    close(): Promise<void>;
}

/**
 * Ce que devient une valeur au transport.
 *
 * Tout en chaîne : un `BIGINT` dépasse le nombre sûr de JavaScript, une date n'a
 * pas la même forme chez les deux moteurs, et un binaire n'a pas de
 * représentation JSON. Le formatage appartient à l'affichage ; ici, on veut
 * seulement ne rien perdre.
 */
function toText(value: unknown): string | null {
    if (value === null || value === undefined) return null;
    if (value instanceof Date) return value.toISOString();
    if (Buffer.isBuffer(value)) return `0x${value.subarray(0, 32).toString('hex')}${value.length > 32 ? '…' : ''}`;
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
}

// --------------------------------------------------------------- dialectes

/**
 * Ce qui distingue les deux moteurs dans la fabrication d'une requête.
 *
 * Deux points, et deux seulement : la façon de citer un identifiant, et la façon
 * de désigner un paramètre. Tout le reste — clauses `WHERE`, `ORDER BY`,
 * `INSERT`, `UPDATE`, `DELETE` — s'écrit une fois pour les deux, ce qui évite
 * que la recherche marche d'un côté et pas de l'autre.
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
 * Les valeurs liées d'une requête en construction.
 *
 * Un compteur partagé, parce que PostgreSQL numérote ses marqueurs : la clause
 * `WHERE`, l'ordre et la fenêtre doivent puiser dans la même suite, sinon `$3`
 * désigne la mauvaise valeur.
 */
class Params {
    readonly values: unknown[] = [];
    constructor(private readonly dialect: Dialect) {}
    add(value: unknown): string {
        this.values.push(value);
        return this.dialect.param(this.values.length);
    }
}

/** Neutralise les jokers d'un `LIKE` : on cherche un texte, pas un motif. */
function escapeLike(value: string): string {
    return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * La clause `WHERE` d'une recherche.
 *
 * L'opérateur vient d'une énumération fermée et la valeur est **toujours liée** :
 * aucun fragment écrit par l'utilisateur n'entre dans le texte de la requête. Le
 * nom de colonne, lui, a été confronté au catalogue par l'appelant — c'est le
 * seul endroit où cette vérification peut se faire.
 */
function buildWhere(d: Dialect, p: Params, filters: DatabaseFilter[] = [], combinator: 'and' | 'or' = 'and'): string {
    if (filters.length === 0) return '';
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
                return `${col} LIKE ${p.add(`%${escapeLike(f.value)}%`)}`;
            case 'starts':
                return `${col} LIKE ${p.add(`${escapeLike(f.value)}%`)}`;
            case 'ends':
                return `${col} LIKE ${p.add(`%${escapeLike(f.value)}`)}`;
            case 'eq':
                return `${col} = ${p.add(f.value)}`;
            default:
                // Inatteignable : `DatabaseFilterOperator` est fermé et tous ses
                // membres sont traités. Le garde-fou vaut pour le jour où l'un
                // s'y ajoute sans passer par ici.
                throw new Error('Opérateur de recherche inconnu.');
        }
    });
    return ` WHERE ${parts.join(combinator === 'or' ? ' OR ' : ' AND ')}`;
}

/** La clause `ORDER BY`, colonne déjà validée par l'appelant. */
function buildOrder(d: Dialect, sort?: DatabaseSort): string {
    if (!sort) return '';
    return ` ORDER BY ${d.quote(sort.column)} ${sort.direction === 'desc' ? 'DESC' : 'ASC'}`;
}

/**
 * La condition qui désigne **une** ligne, par sa clé primaire.
 *
 * `IS NULL` pour une valeur nulle, et non `= NULL` qui ne vaut jamais vrai : une
 * clé primaire ne devrait pas porter de nul, mais une clé qu'on ne retrouve pas
 * silencieusement vaudrait un `UPDATE` sans effet plutôt qu'une erreur.
 */
function keyCondition(d: Dialect, p: Params, key: DatabaseCell[]): string {
    return key
        .map((cell) =>
            cell.value === null ? `${d.quote(cell.column)} IS NULL` : `${d.quote(cell.column)} = ${p.add(cell.value)}`
        )
        .join(' AND ');
}

/** Les lignes plates que rendent les deux catalogues, avant regroupement. */
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

/**
 * Regroupe les lignes plates du catalogue en contraintes et en index.
 *
 * Les deux moteurs rendent une ligne **par colonne** d'une contrainte : une clé
 * composite y occupe deux lignes, appariées par leur position. Le regroupement
 * est donc le même des deux côtés, et vaut d'être écrit une seule fois.
 */
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
 * Refuse tout ce qui n'est pas une lecture unique.
 *
 * Volontairement stricte plutôt que fine : on cherche à empêcher une écriture,
 * pas à analyser du SQL. Le point-virgule interne est refusé parce qu'il ouvre
 * la porte à une seconde instruction — le seul cas où une chaîne « qui commence
 * par SELECT » peut malgré tout écrire.
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
 * Refuse ce qui n'est pas **une seule** instruction — écriture comprise.
 *
 * Le terminal administre : refuser les écritures n'aurait pas de sens, puisque
 * l'explorateur en propose déjà par ses formulaires. Ce qui reste interdit,
 * c'est la salve : un copier-coller de trois instructions dont on ne visait que
 * la première s'exécuterait en entier, sans qu'aucun écran n'ait montré les
 * deux autres.
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

/**
 * La valeur numérique d'une condition d'alerte.
 *
 * Une condition doit rendre **un seul nombre** : c'est ce qui permet de la
 * comparer à un seuil, de la raconter dans un message et de la relire dans
 * l'historique. Un message clair vaut mieux qu'un `NaN` silencieux.
 */
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
        // Le tunnel a été ouvert, la session non : sans ce rattrapage il
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
        // Les entiers hors du domaine sûr reviennent en chaîne plutôt qu'arrondis
        // en silence — un identifiant faux est pire qu'un identifiant textuel.
        supportBigNumbers: true,
        bigNumberStrings: true,
        dateStrings: false,
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

    /** Une écriture : ce qui compte n'est pas ce qu'elle rend, mais combien. */
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
            // La clé primaire dans **l'ordre de la clé**, et non celui des
            // colonnes : sur une clé composite, les deux diffèrent, et c'est
            // l'ordre de la clé qui compte pour désigner une ligne.
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
                    // `auto_increment`, mais aussi les colonnes calculées : dans
                    // les deux cas le moteur refuse qu'on les renseigne.
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
            // Le nom a déjà été confronté à la liste réelle par l'appelant ; il
            // ne reste qu'à le citer, un identifiant ne pouvant pas être un
            // paramètre lié.
            const quoted = `${MYSQL.quote(schema)}.${MYSQL.quote(table)}`;
            const countParams = new Params(MYSQL);
            const where = buildWhere(MYSQL, countParams, page.filters, page.combinator);
            const count = await run(`SELECT COUNT(*) AS n FROM ${quoted}${where}`, countParams.values);

            // Une seconde suite de paramètres : la clause est identique, mais
            // les valeurs sont consommées par une autre requête.
            const pageParams = new Params(MYSQL);
            const sql =
                `SELECT * FROM ${quoted}` +
                buildWhere(MYSQL, pageParams, page.filters, page.combinator) +
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
            // en-tête portant son décompte. C'est la seule chose qui les
            // distingue à ce niveau.
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
        statement_timeout: QUERY_TIMEOUT_MS
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

    /** Une écriture : ce qui compte n'est pas ce qu'elle rend, mais combien. */
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
            // `reltuples` est l'estimation que tient le planificateur : un
            // `COUNT(*)` exact sur chaque table d'un serveur de production
            // coûterait bien plus que ce que cette colonne apporte. `-1` y
            // signifie « jamais analysée », qu'on rend en `null` plutôt qu'en
            // nombre négatif.
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
            // `format('%I.%I', …)::regclass` cite les deux identifiants du côté
            // du serveur : la table est ainsi désignée par un paramètre lié, et
            // non par un nom recollé dans le texte de la requête.
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
            // La clé primaire dans l'ordre de la clé : `indkey` le porte, et
            // c'est lui qui compte pour désigner une ligne.
            const primary = await run(
                `SELECT att.attname
                   FROM pg_index i
                   CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
                   JOIN pg_attribute att ON att.attrelid = i.indrelid AND att.attnum = k.attnum
                  WHERE i.indrelid = ${relation} AND i.indisprimary
                  ORDER BY k.ord ASC`,
                [schema, table]
            );
            // `unnest(conkey, confkey)` apparie les deux côtés **position par
            // position** : une contrainte composite reste donc juste, là où une
            // jointure sur `constraint_column_usage` produirait un produit
            // croisé et de faux appariements.
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
            const where = buildWhere(POSTGRES, countParams, page.filters, page.combinator);
            const count = await run(`SELECT COUNT(*) FROM ${quoted}${where}`, countParams.values);

            const pageParams = new Params(POSTGRES);
            const sql =
                `SELECT * FROM ${quoted}` +
                buildWhere(POSTGRES, pageParams, page.filters, page.combinator) +
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
            // Ici c'est la présence de colonnes qui distingue une lecture d'une
            // écriture : `rowCount` est renseigné dans les deux cas.
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

/**
 * Traduit l'échec d'un pilote en une phrase que l'utilisateur peut corriger.
 *
 * Les codes bruts (`ECONNREFUSED`, `ER_ACCESS_DENIED_ERROR`, `28P01`) ne disent
 * rien à qui n'écrit pas de SQL toute la journée, et c'est pourtant la seule
 * chose qu'il verra à l'écran. Le message d'origine reste dans les journaux.
 */
export function explainError(e: unknown): string {
    const code = typeof e === 'object' && e !== null && 'code' in e ? String((e as { code: unknown }).code) : '';
    const message = e instanceof Error ? e.message : String(e);

    switch (code) {
        case 'ECONNREFUSED':
            return 'Connexion refusée : rien n’écoute sur cet hôte et ce port.';
        case 'ETIMEDOUT':
        case 'ESOCKETTIMEDOUT':
            return 'Le serveur n’a pas répondu dans le délai imparti.';
        case 'ENOTFOUND':
        case 'EAI_AGAIN':
            return 'Hôte introuvable : le nom ne se résout pas.';
        case 'ER_ACCESS_DENIED_ERROR':
        case '28P01':
        case '28000':
            return 'Identifiants refusés par le serveur.';
        case 'ER_BAD_DB_ERROR':
        case '3D000':
            return 'Cette base n’existe pas sur le serveur.';
        case 'ER_DBACCESS_DENIED_ERROR':
        case '42501':
            return 'Ce compte n’a pas le droit de lire cette base.';
        case 'PROTOCOL_CONNECTION_LOST':
            return 'La connexion a été coupée par le serveur.';
        default:
            return message || 'Connexion impossible.';
    }
}
