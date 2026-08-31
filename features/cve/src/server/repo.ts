import type { SdkQueryable } from '@deveye/types/sdk/server';

import type { CveEntryWithFavoriteRow, CveReference, CveSeverity, CveSeverityFilter } from '../contracts/domain';

/** Ce qu'un tour d'ingestion, ou une lecture chez le fournisseur, veut ranger. */
export interface CveUpsert {
    id: string;
    published: number;
    lastModified: number;
    severity: CveSeverity;
    score: number | null;
    vector: string | null;
    cwe: string | null;
    summary: string;
    references: CveReference[];
}

export interface CveRepo {
    /** Le fil : les dernières publiées, filtrées par gravité. */
    listNews(workspaceId: number, severity: CveSeverityFilter, limit: number): Promise<CveEntryWithFavoriteRow[]>;
    /**
     * Le catalogue local. Tous les termes doivent apparaître, dans
     * l'identifiant ou le résumé. Rend une ligne de plus que `limit` pour que
     * l'appelant sache dire « il y en a d'autres » sans compter deux fois.
     */
    search(
        workspaceId: number,
        terms: string[],
        severity: CveSeverityFilter,
        limit: number
    ): Promise<CveEntryWithFavoriteRow[]>;
    find(workspaceId: number, cveId: string): Promise<CveEntryWithFavoriteRow | null>;
    listFavorites(workspaceId: number): Promise<CveEntryWithFavoriteRow[]>;
    /** Range ou rafraîchit des CVE. Rend le nombre de lignes réellement touchées. */
    upsertMany(entries: CveUpsert[]): Promise<number>;
    addFavorite(workspaceId: number, cveId: string, userId: number, at: number): Promise<void>;
    removeFavorite(workspaceId: number, cveId: string): Promise<void>;
    /** Oublie les CVE plus vieilles que `before` qu'aucune épingle ne désigne. */
    purge(before: number): Promise<number>;
    /** L'état global du module (curseur d'ingestion, dernier tour réussi). */
    getState(key: CveStateKey): Promise<number | null>;
    setState(key: CveStateKey, value: number): Promise<void>;
}

/**
 * `ingestCursor` : jusqu'où le fil a été ingéré (secondes epoch, sur la date de
 * modification du NVD). `ingestedAt` : quand le dernier tour a réussi.
 */
export type CveStateKey = 'ingestCursor' | 'ingestedAt';

/** Lignes par INSERT : au-dela, la requete devient trop grosse pour le serveur. */
const UPSERT_CHUNK = 500;

const COLUMNS =
    'e.cve_id, e.published, e.last_modified, e.severity, e.score, e.vector, e.cwe, e.summary, e.refs, e.fetched_at, f.cve_id AS favorite';

const JOIN = 'FROM ft_cve_entries e LEFT JOIN ft_cve_favorites f ON f.cve_id = e.cve_id AND f.workspace_id = ?';

/** La clause de gravité et son paramètre, ou rien du tout pour `all`. */
function severityClause(severity: CveSeverityFilter): { sql: string; params: string[] } {
    return severity === 'all' ? { sql: '', params: [] } : { sql: ' AND e.severity = ?', params: [severity] };
}

/** Échappe ce que LIKE lit comme des jokers, pour qu'un terme reste un terme. */
function likeTerm(term: string): string {
    return `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export function createRepo(q: SdkQueryable): CveRepo {
    return {
        async listNews(workspaceId, severity, limit) {
            const sev = severityClause(severity);
            return q.query<CveEntryWithFavoriteRow>(
                `SELECT ${COLUMNS} ${JOIN} WHERE 1 = 1${sev.sql} ORDER BY e.published DESC, e.cve_id DESC LIMIT ?`,
                [workspaceId, ...sev.params, limit]
            );
        },
        async search(workspaceId, terms, severity, limit) {
            const sev = severityClause(severity);
            const where = terms.map(() => '(e.cve_id LIKE ? OR e.summary LIKE ?)').join(' AND ');
            const params: unknown[] = [workspaceId];
            for (const term of terms) params.push(likeTerm(term), likeTerm(term));
            params.push(...sev.params, limit + 1);
            return q.query<CveEntryWithFavoriteRow>(
                `SELECT ${COLUMNS} ${JOIN} WHERE ${where}${sev.sql} ORDER BY e.published DESC, e.cve_id DESC LIMIT ?`,
                params
            );
        },
        async find(workspaceId, cveId) {
            const rows = await q.query<CveEntryWithFavoriteRow>(`SELECT ${COLUMNS} ${JOIN} WHERE e.cve_id = ?`, [
                workspaceId,
                cveId
            ]);
            return rows[0] ?? null;
        },
        async listFavorites(workspaceId) {
            return q.query<CveEntryWithFavoriteRow>(
                `SELECT ${COLUMNS} FROM ft_cve_favorites f JOIN ft_cve_entries e ON e.cve_id = f.cve_id WHERE f.workspace_id = ? ORDER BY f.created DESC`,
                [workspaceId]
            );
        },
        async upsertMany(entries) {
            if (entries.length === 0) return 0;
            // Un tour d'ingestion en rapporte des milliers : un seul INSERT
            // depasserait `max_allowed_packet`.
            if (entries.length > UPSERT_CHUNK) {
                let touched = 0;
                for (let i = 0; i < entries.length; i += UPSERT_CHUNK) {
                    touched += await this.upsertMany(entries.slice(i, i + UPSERT_CHUNK));
                }
                return touched;
            }
            const now = Math.floor(Date.now() / 1000);
            const values = entries.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
            const params: unknown[] = [];
            for (const e of entries) {
                params.push(
                    e.id,
                    e.published,
                    e.lastModified,
                    e.severity,
                    e.score,
                    e.vector,
                    e.cwe,
                    e.summary,
                    JSON.stringify(e.references),
                    now
                );
            }
            // Revoir une CVE deja connue est le cas NORMAL d'un tour d'ingestion :
            // la reecrire coute moins qu'une lecture prealable, et le NVD republie
            // une CVE des qu'un detail change.
            const res = await q.execute(
                `INSERT INTO ft_cve_entries (cve_id, published, last_modified, severity, score, vector, cwe, summary, refs, fetched_at)
                 VALUES ${values}
                 ON DUPLICATE KEY UPDATE
                    published = VALUES(published), last_modified = VALUES(last_modified),
                    severity = VALUES(severity), score = VALUES(score), vector = VALUES(vector),
                    cwe = VALUES(cwe), summary = VALUES(summary), refs = VALUES(refs),
                    fetched_at = VALUES(fetched_at)`,
                params
            );
            return res.affectedRows;
        },
        async addFavorite(workspaceId, cveId, userId, at) {
            await q.execute(
                'INSERT INTO ft_cve_favorites (workspace_id, cve_id, user_id, created) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE created = created',
                [workspaceId, cveId, userId, at]
            );
        },
        async removeFavorite(workspaceId, cveId) {
            await q.execute('DELETE FROM ft_cve_favorites WHERE workspace_id = ? AND cve_id = ?', [workspaceId, cveId]);
        },
        async purge(before) {
            const res = await q.execute(
                'DELETE FROM ft_cve_entries WHERE published < ? AND NOT EXISTS (SELECT 1 FROM ft_cve_favorites f WHERE f.cve_id = ft_cve_entries.cve_id)',
                [before]
            );
            return res.affectedRows;
        },
        async getState(key) {
            const rows = await q.query<{ v: number }>('SELECT v FROM ft_cve_state WHERE k = ?', [key]);
            return rows[0]?.v ?? null;
        },
        async setState(key, value) {
            await q.execute('INSERT INTO ft_cve_state (k, v) VALUES (?, ?) ON DUPLICATE KEY UPDATE v = VALUES(v)', [
                key,
                value
            ]);
        }
    };
}
