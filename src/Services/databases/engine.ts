import mysql from 'mysql2/promise';
import { Client as PgClient } from 'pg';
import type { DatabaseEngine, DatabaseRows, DatabaseTable } from 'deveye-types';
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

/** Une session ouverte sur une base, le temps d'une suite d'opérations. */
export interface Session {
    serverVersion(): Promise<string>;
    inventory(): Promise<Inventory>;
    tables(): Promise<DatabaseTable[]>;
    /** Le contenu d'une table, nom validé contre la liste réelle par l'appelant. */
    tableRows(schema: string, table: string, offset: number, limit: number): Promise<DatabaseRows>;
    /** Une requête de lecture, telle que l'utilisateur l'a écrite. */
    query(sql: string): Promise<DatabaseRows>;
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
        async tableRows(schema, table, offset, limit) {
            // Le nom a déjà été confronté à la liste réelle par l'appelant ; il
            // ne reste qu'à le citer, un identifiant ne pouvant pas être un
            // paramètre lié.
            const quoted = `\`${schema.replace(/`/g, '')}\`.\`${table.replace(/`/g, '')}\``;
            const count = await run(`SELECT COUNT(*) AS n FROM ${quoted}`);
            const page = await run(`SELECT * FROM ${quoted} LIMIT ? OFFSET ?`, [limit, offset]);
            return { ...page, total: Number(count.rows[0]?.[0] ?? 0) };
        },
        async query(sql) {
            assertReadOnly(sql);
            return run(sql);
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
        async tableRows(schema, table, offset, limit) {
            const quoted = `"${schema.replace(/"/g, '')}"."${table.replace(/"/g, '')}"`;
            const count = await run(`SELECT COUNT(*) FROM ${quoted}`);
            const page = await run(`SELECT * FROM ${quoted} LIMIT $1 OFFSET $2`, [limit, offset]);
            return { ...page, total: Number(count.rows[0]?.[0] ?? 0) };
        },
        async query(sql) {
            assertReadOnly(sql);
            return run(sql);
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
