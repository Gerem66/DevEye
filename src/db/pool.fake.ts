import { databaseOn, type Database } from './index';
import type { Queryable, QueryResultLike } from './pool';

/** Une requête telle qu'un dépôt l'a émise. */
export interface RecordedQuery {
    sql: string;
    params: unknown[];
}

/**
 * Ce qu'une requête reçoit : des lignes pour une lecture, ou le compte de
 * lignes touchées et l'identifiant inséré pour une écriture.
 */
export type FakeAnswer = unknown[] | Partial<Pick<QueryResultLike<never>, 'rowCount' | 'insertId'>>;

export type Answer = (sql: string, params: unknown[]) => FakeAnswer | undefined;

export interface FakeQueryable extends Queryable {
    /** Tout ce qui a été émis, dans l'ordre. */
    queries: RecordedQuery[];
}

/**
 * Un `Queryable` qui n'exécute rien : il retient chaque requête, pour prouver
 * ce qu'un dépôt a émis et surtout ce qu'il n'a pas émis, et rend ce que
 * `answer` décide. Sans réponse, une lecture rend zéro ligne et une écriture en
 * compte une, sous l'identifiant 1.
 */
export function fakeQueryable(answer?: Answer): FakeQueryable {
    const queries: RecordedQuery[] = [];
    return {
        queries,
        async query<T>(sql: string, params?: unknown[]): Promise<QueryResultLike<T>> {
            const bound = params ?? [];
            queries.push({ sql, params: bound });
            const given = answer?.(sql, bound);
            if (Array.isArray(given)) return { rows: given as T[], rowCount: given.length, insertId: 0 };
            if (/^\s*SELECT\b/i.test(sql)) return { rows: [], rowCount: 0, insertId: 0 };
            return { rows: [], rowCount: given?.rowCount ?? 1, insertId: given?.insertId ?? 1 };
        }
    };
}

/** Les dépôts du socle sur un faux `Queryable` ; une transaction reste sur lui. */
export function fakeDatabase(answer?: Answer): { db: Database; queries: RecordedQuery[] } {
    const q = fakeQueryable(answer);
    return { db: databaseOn(q, (fn) => fn(q)), queries: q.queries };
}
