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
    /** Les produits touchés, d'après les configurations du NVD. Vide tant qu'il ne les a pas analysés. */
    products: Omit<CveProductRow, 'cve_id'>[];
}

/** Un produit touché par une CVE : une version exacte, ou des bornes. */
export interface CveProductRow {
    cve_id: string;
    vendor: string;
    product: string;
    version: string | null;
    start_incl: string | null;
    start_excl: string | null;
    end_incl: string | null;
    end_excl: string | null;
}

/** Une CVE d'un produit, avec les bornes de la ligne qui l'y rattache. */
export interface CveAffectingRow extends CveProductRow {
    severity: CveSeverity;
    score: number | null;
    summary: string;
    published: number;
}

export interface CveWatchedRow {
    vendor: string;
    product: string;
    requested_at: number;
    backfill_index: number;
    backfilled_at: number | null;
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
    /**
     * Oublie les CVE plus vieilles que `before` qu'aucune épingle ne désigne et
     * qui ne touchent aucun produit surveillé, puis les produits devenus orphelins.
     */
    purge(before: number): Promise<number>;
    /** Ajoute des produits à surveiller. Rend combien ne l'étaient pas déjà. */
    watch(products: readonly { vendor: string; product: string }[], at: number): Promise<number>;
    listWatched(): Promise<CveWatchedRow[]>;
    setBackfill(vendor: string, product: string, index: number, doneAt: number | null): Promise<void>;
    /** Toutes les lignes qui rattachent une CVE à ce produit. */
    affecting(vendor: string, product: string): Promise<CveAffectingRow[]>;
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
            // une CVE des qu'un detail change. Ses produits sont reecrits avec elle.
            await q.execute('DELETE FROM ft_cve_products WHERE cve_id IN (?)', [entries.map((e) => e.id)]);
            const products = entries.flatMap((e) => e.products.map((p) => ({ ...p, cve_id: e.id })));
            if (products.length > 0) {
                await q.execute(
                    `INSERT INTO ft_cve_products (cve_id, vendor, product, version, start_incl, start_excl, end_incl, end_excl)
                     VALUES ${products.map(() => '(?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}`,
                    products.flatMap((p) => [
                        p.cve_id,
                        p.vendor,
                        p.product,
                        p.version,
                        p.start_incl,
                        p.start_excl,
                        p.end_incl,
                        p.end_excl
                    ])
                );
            }
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
                `DELETE FROM ft_cve_entries
                  WHERE published < ?
                    AND NOT EXISTS (SELECT 1 FROM ft_cve_favorites f WHERE f.cve_id = ft_cve_entries.cve_id)
                    AND NOT EXISTS (SELECT 1 FROM ft_cve_products p
                                      JOIN ft_cve_watched w ON w.vendor = p.vendor AND w.product = p.product
                                     WHERE p.cve_id = ft_cve_entries.cve_id)`,
                [before]
            );
            await q.execute(
                `DELETE p FROM ft_cve_products p
                   LEFT JOIN ft_cve_entries e ON e.cve_id = p.cve_id
                  WHERE e.cve_id IS NULL`
            );
            return res.affectedRows;
        },
        async watch(products, at) {
            let added = 0;
            for (const p of products) {
                const res = await q.execute(
                    'INSERT IGNORE INTO ft_cve_watched (vendor, product, requested_at) VALUES (?, ?, ?)',
                    [p.vendor, p.product, at]
                );
                added += res.affectedRows;
            }
            return added;
        },
        async listWatched() {
            return q.query<CveWatchedRow>(
                'SELECT vendor, product, requested_at, backfill_index, backfilled_at FROM ft_cve_watched ORDER BY requested_at, vendor, product'
            );
        },
        async setBackfill(vendor, product, index, doneAt) {
            await q.execute(
                'UPDATE ft_cve_watched SET backfill_index = ?, backfilled_at = ? WHERE vendor = ? AND product = ?',
                [index, doneAt, vendor, product]
            );
        },
        async affecting(vendor, product) {
            return q.query<CveAffectingRow>(
                `SELECT p.cve_id, p.vendor, p.product, p.version, p.start_incl, p.start_excl, p.end_incl, p.end_excl,
                        e.severity, e.score, e.summary, e.published
                   FROM ft_cve_products p
                   JOIN ft_cve_entries e ON e.cve_id = p.cve_id
                  WHERE p.vendor = ? AND p.product = ?`,
                [vendor, product]
            );
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
