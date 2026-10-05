import type { LogEntry } from '@deveye/types';
import { selectColumns } from '../columns';
import type { Queryable } from '../pool';

type Q = Queryable;

/** A new audit entry to persist. `metadata` is serialized to the JSON column. */
export interface RecordLogInput {
    uid: number;
    ip: string;
    source: string;
    category: string;
    action: string;
    level: number;
    description: string;
    metadata?: unknown;
}

/** AND-combined filter for {@link LogsRepo.query}; every field is optional. */
export interface LogQueryFilter {
    uid?: number;
    source?: string;
    category?: string;
    action?: string;
    /** Importance floor, inclusive (`level >= levelMin`). */
    levelMin?: number;
    /** Case-insensitive substring over description / action / ip. */
    search?: string;
    ip?: string;
    /** Unix seconds, inclusive. */
    dateFrom?: number;
    dateTo?: number;
}

export interface LogPage {
    logs: LogEntry[];
    /** Count matching the filter, ignoring paging. */
    total: number;
}

export interface LogFacets {
    users: { uid: number; username: string | null; count: number }[];
    categories: { value: string; count: number }[];
    sources: { value: string; count: number }[];
    actions: { value: string; count: number }[];
    total: number;
}

export interface LogsRepo {
    record(input: RecordLogInput): Promise<void>;
    query(filter: LogQueryFilter, paging: { limit: number; offset: number }): Promise<LogPage>;
    facets(): Promise<LogFacets>;
    /** Supprime au plus `batch` lignes antérieures à `cutoff` (secondes), et dit combien. */
    purgeBefore(cutoff: number, batch: number): Promise<number>;
}

/** Row shape of the list query (logs joined to users for the display name). */
interface LogJoinRow {
    id: number;
    date: number;
    level: number;
    source: string;
    category: string;
    action: string;
    uid: number;
    ip: string;
    description: string;
    metadata: unknown;
    username: string | null;
}

/**
 * The JSON `metadata` column comes back already parsed from mysql2 in most
 * setups, but can surface as a string — normalize either to a plain object, or
 * null when absent / unparseable.
 */
function parseMetadata(raw: unknown): Record<string, unknown> | null {
    if (raw === null || raw === undefined) return null;
    if (typeof raw === 'object') return raw as Record<string, unknown>;
    if (typeof raw === 'string') {
        try {
            const parsed = JSON.parse(raw) as unknown;
            return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
        } catch {
            return null;
        }
    }
    return null;
}

const JOIN_COLUMNS = selectColumns<LogJoinRow>('l', {
    id: true,
    date: true,
    level: true,
    source: true,
    category: true,
    action: true,
    uid: true,
    ip: true,
    description: true,
    metadata: true,
    username: 'u.username'
});

function toEntry(r: LogJoinRow): LogEntry {
    return {
        id: r.id,
        date: Number(r.date),
        level: r.level,
        source: r.source as LogEntry['source'],
        category: r.category,
        action: r.action,
        uid: r.uid,
        username: r.username ?? null,
        ip: r.ip,
        description: r.description,
        metadata: parseMetadata(r.metadata)
    };
}

/** Build the shared WHERE clause + bound params from a filter. */
function buildWhere(filter: LogQueryFilter): { where: string; params: unknown[] } {
    const conds: string[] = [];
    const params: unknown[] = [];
    if (filter.uid !== undefined) {
        conds.push('l.uid = ?');
        params.push(filter.uid);
    }
    if (filter.source !== undefined) {
        conds.push('l.source = ?');
        params.push(filter.source);
    }
    if (filter.category !== undefined) {
        conds.push('l.category = ?');
        params.push(filter.category);
    }
    if (filter.action !== undefined) {
        conds.push('l.action = ?');
        params.push(filter.action);
    }
    if (filter.levelMin !== undefined) {
        conds.push('l.level >= ?');
        params.push(filter.levelMin);
    }
    if (filter.ip !== undefined) {
        conds.push('l.ip = ?');
        params.push(filter.ip);
    }
    if (filter.dateFrom !== undefined) {
        conds.push('l.date >= ?');
        params.push(filter.dateFrom);
    }
    if (filter.dateTo !== undefined) {
        conds.push('l.date <= ?');
        params.push(filter.dateTo);
    }
    if (filter.search) {
        const like = `%${filter.search}%`;
        conds.push('(l.description LIKE ? OR l.action LIKE ? OR l.ip LIKE ?)');
        params.push(like, like, like);
    }
    return { where: conds.length ? `WHERE ${conds.join(' AND ')}` : '', params };
}

export function logsRepo(pool: Q): LogsRepo {
    return {
        async record({ uid, ip, source, category, action, level, description, metadata }) {
            await pool.query(
                `INSERT INTO logs (uid, ip, source, category, action, level, description, metadata)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    uid,
                    ip,
                    source,
                    category,
                    action,
                    level,
                    description,
                    metadata === undefined || metadata === null ? null : JSON.stringify(metadata)
                ]
            );
        },

        async query(filter, { limit, offset }) {
            const { where, params } = buildWhere(filter);

            const countRes = await pool.query<{ total: number }>(
                `SELECT COUNT(*) AS total FROM logs l ${where}`,
                params
            );
            const total = Number(countRes.rows[0]?.total ?? 0);

            const rows = await pool.query<LogJoinRow>(
                `SELECT ${JOIN_COLUMNS}
                 FROM logs l
                 LEFT JOIN users u ON u.id = l.uid
                 ${where}
                 ORDER BY l.date DESC, l.id DESC
                 LIMIT ? OFFSET ?`,
                [...params, limit, offset]
            );

            return { logs: rows.rows.map(toEntry), total };
        },

        async purgeBefore(cutoff, batch) {
            const r = await pool.query('DELETE FROM logs WHERE date < ? LIMIT ?', [cutoff, batch]);
            return r.rowCount;
        },

        async facets() {
            const [users, categories, sources, actions, totalRes] = await Promise.all([
                pool.query<{ uid: number; username: string | null; count: number }>(
                    `SELECT l.uid AS uid, u.username AS username, COUNT(*) AS count
                     FROM logs l
                     LEFT JOIN users u ON u.id = l.uid
                     GROUP BY l.uid, u.username
                     ORDER BY count DESC`
                ),
                pool.query<{ value: string; count: number }>(
                    `SELECT category AS value, COUNT(*) AS count FROM logs
                     GROUP BY category ORDER BY count DESC`
                ),
                pool.query<{ value: string; count: number }>(
                    `SELECT source AS value, COUNT(*) AS count FROM logs
                     GROUP BY source ORDER BY count DESC`
                ),
                pool.query<{ value: string; count: number }>(
                    `SELECT action AS value, COUNT(*) AS count FROM logs
                     GROUP BY action ORDER BY count DESC LIMIT 200`
                ),
                pool.query<{ total: number }>(`SELECT COUNT(*) AS total FROM logs`)
            ]);

            return {
                users: users.rows.map((r) => ({ uid: r.uid, username: r.username ?? null, count: Number(r.count) })),
                categories: categories.rows.map((r) => ({ value: r.value, count: Number(r.count) })),
                sources: sources.rows.map((r) => ({ value: r.value, count: Number(r.count) })),
                actions: actions.rows.map((r) => ({ value: r.value, count: Number(r.count) })),
                total: Number(totalRes.rows[0]?.total ?? 0)
            };
        }
    };
}
