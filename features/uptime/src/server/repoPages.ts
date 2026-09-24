import type {
    UptimeDayRow,
    UptimeIncidentRow,
    UptimePageRow,
    UptimePageServiceRow,
    UptimePageTheme,
    UptimeServiceRow
} from '../contracts/domain';
import type { SdkQueryable } from '@deveye/types/sdk/server';

/**
 * Les pages de statut : leur réglage, et les lectures groupées que la page
 * publique fait pour tous ses services d'un coup. Section détachée de
 * `repo.ts` ; les deux se rejoignent dans un seul `UptimeRepo`.
 *
 * Le dépôt ne chiffre jamais : l'appelant lui passe du déjà scellé.
 */

/** Ce qui se règle sur une page, hors de ses services. */
export interface UptimePageConfig {
    /** Encrypted `{ title, description }`. */
    content: string;
    domainId: number | null;
    theme: UptimePageTheme;
    showErrors: boolean;
    showLatency: boolean;
    enabled: boolean;
}

/** Un service d'une page, dans l'ordre d'écriture. */
export interface UptimePageEntry {
    serviceId: number;
    /** Encrypted public name, or null for the service's own. */
    label: string | null;
}

/** Un service tel que la page publique le lit : sa ligne, et son nom public scellé. */
export interface UptimeStatusServiceRow extends UptimeServiceRow {
    page_label: string | null;
}

/** Le temps de réponse d'une heure, avant moyenne. */
export interface UptimeHourLatencyRow {
    service_id: number;
    at: number;
    total_ms: number;
    samples: number;
}

export interface UptimePagesRepo {
    listByWorkspace(workspaceId: number): Promise<UptimePageRow[]>;
    /** Les services de ces pages, chacune dans son ordre. */
    entriesOf(pageIds: readonly number[]): Promise<UptimePageServiceRow[]>;
    find(id: number, workspaceId: number): Promise<UptimePageRow | null>;
    findByRef(ref: string): Promise<UptimePageRow | null>;
    findByDomain(domainId: number): Promise<UptimePageRow | null>;
    countInWorkspaces(workspaceIds: readonly number[]): Promise<number>;
    create(input: { workspaceId: number; publicRef: string } & UptimePageConfig): Promise<UptimePageRow>;
    update(id: number, workspaceId: number, config: UptimePageConfig): Promise<UptimePageRow | null>;
    /**
     * Les services de la page, dans cet ordre. Écrits avant que les absents ne
     * partent : un échec en route laisse une page trop pleine, jamais vide.
     */
    setEntries(pageId: number, entries: readonly UptimePageEntry[]): Promise<void>;
    delete(id: number, workspaceId: number): Promise<boolean>;
    /** Combien de pages chaque domaine de l'espace sert. */
    domainUse(workspaceId: number): Promise<Map<number, number>>;
    clearDomain(domainId: number, workspaceId: number): Promise<void>;
}

export interface UptimeStatusRepo {
    /** Les services d'une page, dans son ordre, et seulement ceux de son espace. */
    servicesOf(pageId: number, workspaceId: number): Promise<UptimeStatusServiceRow[]>;
    /** Le cumul journalier de ces services, du jour `sinceDay` (minuit UTC) à aujourd'hui. */
    dailyOf(serviceIds: readonly number[], sinceDay: number): Promise<UptimeDayRow[]>;
    /** Leurs pannes en cours, et celles terminées depuis `since`, les plus récentes d'abord. */
    incidentsOf(serviceIds: readonly number[], since: number, limit: number): Promise<UptimeIncidentRow[]>;
    /** Leur temps de réponse heure par heure depuis `since`. */
    hourlyLatencyOf(serviceIds: readonly number[], since: number): Promise<UptimeHourLatencyRow[]>;
}

const PAGE_COLUMNS = 'content = ?, domain_id = ?, theme = ?, show_errors = ?, show_latency = ?, enabled = ?';

function pageParams(c: UptimePageConfig): unknown[] {
    return [c.content, c.domainId, c.theme, c.showErrors ? 1 : 0, c.showLatency ? 1 : 0, c.enabled ? 1 : 0];
}

export function createPagesRepo(q: SdkQueryable): UptimePagesRepo {
    async function find(id: number, workspaceId: number): Promise<UptimePageRow | null> {
        const rows = await q.query<UptimePageRow>('SELECT * FROM ft_uptime_pages WHERE id = ? AND workspace_id = ?', [
            id,
            workspaceId
        ]);
        return rows[0] ?? null;
    }

    return {
        listByWorkspace: (workspaceId) =>
            q.query<UptimePageRow>('SELECT * FROM ft_uptime_pages WHERE workspace_id = ? ORDER BY id ASC', [
                workspaceId
            ]),
        async entriesOf(pageIds) {
            if (pageIds.length === 0) return [];
            return q.query<UptimePageServiceRow>(
                `SELECT * FROM ft_uptime_page_services WHERE page_id IN (?)
                 ORDER BY page_id ASC, sort_order ASC, service_id ASC`,
                [[...pageIds]]
            );
        },
        find,
        async findByRef(ref) {
            const rows = await q.query<UptimePageRow>('SELECT * FROM ft_uptime_pages WHERE public_ref = ?', [ref]);
            return rows[0] ?? null;
        },
        async findByDomain(domainId) {
            const rows = await q.query<UptimePageRow>('SELECT * FROM ft_uptime_pages WHERE domain_id = ?', [domainId]);
            return rows[0] ?? null;
        },
        async countInWorkspaces(workspaceIds) {
            if (workspaceIds.length === 0) return 0;
            const rows = await q.query<{ n: number }>(
                'SELECT COUNT(*) AS n FROM ft_uptime_pages WHERE workspace_id IN (?)',
                [[...workspaceIds]]
            );
            return Number(rows[0]?.n ?? 0);
        },
        async create({ workspaceId, publicRef, ...config }) {
            const res = await q.execute(
                `INSERT INTO ft_uptime_pages
                     (workspace_id, public_ref, content, domain_id, theme, show_errors, show_latency, enabled)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [workspaceId, publicRef, ...pageParams(config)]
            );
            return (await find(res.insertId, workspaceId)) as UptimePageRow;
        },
        async update(id, workspaceId, config) {
            await q.execute(`UPDATE ft_uptime_pages SET ${PAGE_COLUMNS} WHERE id = ? AND workspace_id = ?`, [
                ...pageParams(config),
                id,
                workspaceId
            ]);
            return find(id, workspaceId);
        },
        async setEntries(pageId, entries) {
            for (const [rank, entry] of entries.entries()) {
                await q.execute(
                    `INSERT INTO ft_uptime_page_services (page_id, service_id, sort_order, label)
                     VALUES (?, ?, ?, ?)
                     ON DUPLICATE KEY UPDATE sort_order = VALUES(sort_order), label = VALUES(label)`,
                    [pageId, entry.serviceId, rank, entry.label]
                );
            }
            const kept = entries.map((entry) => entry.serviceId);
            if (kept.length === 0) {
                await q.execute('DELETE FROM ft_uptime_page_services WHERE page_id = ?', [pageId]);
            } else {
                await q.execute('DELETE FROM ft_uptime_page_services WHERE page_id = ? AND service_id NOT IN (?)', [
                    pageId,
                    kept
                ]);
            }
        },
        async delete(id, workspaceId) {
            const res = await q.execute('DELETE FROM ft_uptime_pages WHERE id = ? AND workspace_id = ?', [
                id,
                workspaceId
            ]);
            return res.affectedRows > 0;
        },
        async domainUse(workspaceId) {
            const rows = await q.query<{ domain_id: number; n: number }>(
                `SELECT domain_id, COUNT(*) AS n FROM ft_uptime_pages
                 WHERE workspace_id = ? AND domain_id IS NOT NULL GROUP BY domain_id`,
                [workspaceId]
            );
            return new Map(rows.map((row) => [Number(row.domain_id), Number(row.n)]));
        },
        async clearDomain(domainId, workspaceId) {
            await q.execute('UPDATE ft_uptime_pages SET domain_id = NULL WHERE domain_id = ? AND workspace_id = ?', [
                domainId,
                workspaceId
            ]);
        }
    };
}

export function createStatusRepo(q: SdkQueryable): UptimeStatusRepo {
    return {
        servicesOf: (pageId, workspaceId) =>
            // La jointure sur l'espace de la page est une seconde garde : une
            // page ne montre jamais le service d'un autre espace, quoi que
            // contienne sa liste.
            q.query<UptimeStatusServiceRow>(
                `SELECT s.*, ps.label AS page_label
                 FROM ft_uptime_page_services ps
                 JOIN ft_uptime_pages p ON p.id = ps.page_id
                 JOIN uptime_services s ON s.id = ps.service_id AND s.workspace_id = p.workspace_id
                 WHERE ps.page_id = ? AND p.workspace_id = ?
                 ORDER BY ps.sort_order ASC, s.id ASC`,
                [pageId, workspaceId]
            ),
        async dailyOf(serviceIds, sinceDay) {
            if (serviceIds.length === 0) return [];
            return q.query<UptimeDayRow>(
                'SELECT * FROM uptime_daily WHERE service_id IN (?) AND day >= ? ORDER BY service_id ASC, day ASC',
                [[...serviceIds], sinceDay]
            );
        },
        async incidentsOf(serviceIds, since, limit) {
            if (serviceIds.length === 0) return [];
            return q.query<UptimeIncidentRow>(
                `SELECT * FROM uptime_incidents
                 WHERE service_id IN (?) AND (ended_at IS NULL OR ended_at >= ?)
                 ORDER BY started_at DESC LIMIT ?`,
                [[...serviceIds], since, limit]
            );
        },
        async hourlyLatencyOf(serviceIds, since) {
            if (serviceIds.length === 0) return [];
            return q.query<UptimeHourLatencyRow>(
                `SELECT service_id,
                        (checked_at DIV 3600) * 3600 AS at,
                        COALESCE(SUM(response_ms), 0) AS total_ms,
                        COUNT(response_ms)           AS samples
                 FROM uptime_checks
                 WHERE service_id IN (?) AND checked_at >= ?
                 GROUP BY service_id, at
                 ORDER BY service_id ASC, at ASC`,
                [[...serviceIds], since]
            );
        }
    };
}
