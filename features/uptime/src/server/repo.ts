import type {
    UptimeCheckRow,
    UptimeCheckStats,
    UptimeDeploySource,
    UptimeDeploySourceRow,
    UptimeIncidentRow,
    UptimeIntegrityOutcome,
    UptimeIntegrityReadingRow,
    UptimeMethod,
    UptimePoint,
    UptimeServiceRow,
    UptimeStatus
} from '../contracts/domain';
import type { SdkQueryable, SdkStockItem } from '@deveye/types/sdk/server';

import { createPagesRepo, createStatusRepo, type UptimePagesRepo, type UptimeStatusRepo } from './repoPages';

/** Which pings a journal query covers; mirrors the shared command filter. */
export interface UptimeCheckFilter {
    /** Keep only probes at or after this epoch second; `null` = everything. */
    since: number | null;
    failuresOnly: boolean;
}

/** A service's identity and tuning, as its General tab writes them. */
export interface UptimeServiceConfig {
    /** Encrypted `{ name, url, keyword, paths, deployAccept }`. */
    content: string;
    method: UptimeMethod;
    expectedStatus: number | null;
    intervalSeconds: number;
    timeoutSeconds: number;
    failureThreshold: number;
    retentionDays: number | null;
    enabled: boolean;
}

/** Outcome of one probe, as written back to the service row. */
export interface UptimeProbeResult {
    status: UptimeStatus;
    consecutiveFailures: number;
    checkedAt: number;
    responseMs: number | null;
    httpStatus: number | null;
    /** Encrypted error message, or null after a success. */
    error: string | null;
}

/** A reading of the files, as written back to the service row. */
export interface UptimeIntegrityReading {
    checkedAt: number;
    failures: number;
    /** Encrypted verdict, or null while the files conform. */
    verdict: string | null;
    /** Encrypted reference learned at this reading; otherwise the stored one stays. */
    baseline: string | null;
    /** Since when a drift waits for a deployment under way; null otherwise. */
    pendingSince: number | null;
}

/** Success ratio + mean latency of one service over a window. */
export interface UptimeWindowStat {
    serviceId: number;
    checks: number;
    upChecks: number;
    avgMs: number | null;
}

export interface UptimeServicesRepo {
    listByWorkspace(workspaceId: number): Promise<UptimeServiceRow[]>;
    countInWorkspaces(workspaceIds: readonly number[]): Promise<number>;
    /** Ce que `countInWorkspaces` compte, les plus anciens d'abord : l'offre fait tourner ceux de tête. */
    listStock(workspaceIds: readonly number[]): Promise<SdkStockItem[]>;
    /**
     * Les services **visibles** depuis cet espace : les siens, plus ceux qu'un
     * autre espace y projette (`item_shares`).
     *
     * Séparé de `listByWorkspace` plutôt que de le remplacer : l'ordonnanceur de
     * fond sonde les services d'un espace, pas ce qu'on y voit (sonder deux
     * fois le même service parce qu'il est projeté ailleurs serait un doublon de
     * requêtes et d'incidents).
     */
    listVisible(workspaceId: number): Promise<UptimeServiceRow[]>;
    findById(id: number, workspaceId: number): Promise<UptimeServiceRow | null>;
    /** Comme `findById`, mais accepte aussi un service projeté vers cet espace. */
    findVisible(id: number, workspaceId: number): Promise<UptimeServiceRow | null>;
    create(
        input: {
            userId: number;
            workspaceId: number;
            /** `null`: the integrity option is off. */
            integrityIntervalSeconds: number | null;
        } & UptimeServiceConfig
    ): Promise<UptimeServiceRow>;
    update(id: number, workspaceId: number, input: UptimeServiceConfig): Promise<UptimeServiceRow | null>;
    /** The integrity option, as its tab writes it: on or off (`null`), and the content that carries its paths. */
    setIntegrity(
        id: number,
        workspaceId: number,
        input: { content: string; integrityIntervalSeconds: number | null }
    ): Promise<UptimeServiceRow | null>;
    setEnabled(id: number, workspaceId: number, enabled: boolean): Promise<UptimeServiceRow | null>;
    delete(id: number, workspaceId: number): Promise<boolean>;
    /**
     * File the user's services in the given order, ranking each by its index.
     * The caller passes the workspace's complete list, so ranks stay dense.
     */
    reorder(workspaceId: number, ids: number[]): Promise<void>;
    /**
     * Les services actifs dont la sonde est due à `now`, les plus en retard
     * d'abord, tous espaces confondus : ce que relève l'ordonnanceur de fond.
     * `planPaused` s'écarte dans la requête, avant le `LIMIT` : jamais sondés,
     * ils resteraient en tête de file et affameraient les autres.
     */
    listDue(now: number, limit: number, planPaused: readonly number[]): Promise<UptimeServiceRow[]>;
    /** Write back the outcome of a probe. */
    recordProbe(id: number, result: UptimeProbeResult): Promise<void>;
    /** Integrity: write back a reading of the files; `baseline` only when it was learned at this reading. */
    recordIntegrity(id: number, reading: UptimeIntegrityReading): Promise<void>;
    /** Les sources de déploiement de ces services, dans l'ordre où elles ont été choisies. */
    listDeploySources(serviceIds: readonly number[]): Promise<UptimeDeploySourceRow[]>;
    /** Remplace les sources d'un service ; une liste vide les retire toutes. */
    setDeploySources(serviceId: number, sources: readonly UptimeDeploySource[]): Promise<void>;
    /** Pose ou retire (`null`) l'adresse d'appel : son condensat et son jeton chiffré. */
    setDeployHook(serviceId: number, hook: { hash: string; enc: string } | null): Promise<void>;
    findByDeployHook(hash: string): Promise<UptimeServiceRow | null>;
    markDeployHookCalled(serviceId: number, at: number): Promise<void>;
    /**
     * Integrity: forget the reference and the verdict, so the next probe
     * rereads the files and learns what the site serves.
     */
    resetIntegrity(id: number): Promise<void>;
    /**
     * Counts of the **active** services of one workspace. `up + down` can be
     * below `total`: a service awaiting its first probe is neither, and must
     * not be reported as a failure.
     */
}

export interface UptimeHistoryRepo {
    /** Append one raw ping and fold it into its daily bucket. */
    addCheck(input: {
        serviceId: number;
        checkedAt: number;
        up: boolean;
        httpStatus: number | null;
        responseMs: number | null;
        /** Encrypted error message. */
        error: string | null;
    }): Promise<void>;
    /** Raw pings matching `filter` before `before` (exclusive), most recent first. */
    listChecks(serviceId: number, filter: UptimeCheckFilter, limit: number, before?: number): Promise<UptimeCheckRow[]>;
    /** Aggregates over the whole filtered selection, not one page of it. */
    checkStats(serviceId: number, filter: UptimeCheckFilter): Promise<UptimeCheckStats>;
    /**
     * One point per ping over `[since, ∞)`, oldest first. When the window holds
     * more than `limit` pings the **oldest** are dropped, so the series always
     * runs up to now rather than stopping short.
     */
    rawPoints(serviceId: number, since: number, limit: number): Promise<UptimePoint[]>;
    /** Raw pings folded into hourly buckets over `[since, ∞)`, oldest first. */
    hourlyPoints(serviceId: number, since: number): Promise<UptimePoint[]>;
    /** Daily rollup rows over `[since, ∞)`, oldest first (`since = 0` = all). */
    dailyPoints(serviceId: number, since: number): Promise<UptimePoint[]>;
    /**
     * Success ratio + mean latency per service over the **raw** pings since
     * `since`, for one user. Exact to the second, so it backs the 24 h figure.
     */
    windowStats(workspaceId: number, since: number): Promise<UptimeWindowStat[]>;
    /**
     * Same, read from the daily rollup from `sinceDay` (UTC midnight) onwards.
     * What the multi-day ratios use: bounded to one row per service per day, and
     * still complete once the raw pings have been pruned.
     */
    dailyWindowStats(workspaceId: number, sinceDay: number): Promise<UptimeWindowStat[]>;
    /** The service's still-open incident, if any. */
    openIncident(serviceId: number): Promise<UptimeIncidentRow | null>;
    /** Every ongoing outage across one user's services (at most one per service). */
    listOpenIncidents(workspaceId: number): Promise<UptimeIncidentRow[]>;
    /** Open an outage; `error` is already encrypted. */
    openIncidentAt(input: {
        serviceId: number;
        startedAt: number;
        httpStatus: number | null;
        error: string | null;
    }): Promise<UptimeIncidentRow>;
    /** Mark the "service is down" alert as delivered for this incident. */
    markIncidentNotified(id: number): Promise<void>;
    /** Close an outage at `endedAt`. */
    closeIncident(id: number, endedAt: number): Promise<void>;
    listIncidents(serviceId: number, limit: number): Promise<UptimeIncidentRow[]>;
    /** Journal des intégrités : inscrit une lecture des fichiers. */
    addReading(input: {
        serviceId: number;
        checkedAt: number;
        outcome: UptimeIntegrityOutcome;
        fileCount: number | null;
        slowestMs: number | null;
        /** `{ error, lines }` chiffré. */
        detail: string | null;
    }): Promise<void>;
    /** Les lectures avant `before` (exclu), la plus récente d'abord. */
    listReadings(serviceId: number, limit: number, before?: number): Promise<UptimeIntegrityReadingRow[]>;
    /** La dernière lecture qui a retrouvé la référence ou l'a apprise, `null` sans aucune. */
    lastConformAt(serviceId: number): Promise<number | null>;
    /**
     * Drop raw pings and readings of the files older than each service's own
     * `retention_days`. Services with no retention keep everything; the daily
     * rollup is never touched.
     */
    pruneByRetention(now: number): Promise<{ checks: number; readings: number }>;
}

export interface UptimeRepo {
    services: UptimeServicesRepo;
    history: UptimeHistoryRepo;
    /** Les pages de statut, et ce que leur rendu public lit (`repoPages.ts`). */
    pages: UptimePagesRepo;
    status: UptimeStatusRepo;
}

const SERVICE_COLUMNS = `content = ?, method = ?, expected_status = ?,
     interval_seconds = ?, timeout_seconds = ?, failure_threshold = ?, retention_days = ?, enabled = ?`;

function configParams(c: UptimeServiceConfig): unknown[] {
    return [
        c.content,
        c.method,
        c.expectedStatus,
        c.intervalSeconds,
        c.timeoutSeconds,
        c.failureThreshold,
        c.retentionDays,
        c.enabled ? 1 : 0
    ];
}

/** WHERE clause shared by the journal page and its aggregates. */
function checkFilterSql(serviceId: number, filter: UptimeCheckFilter): { where: string[]; params: unknown[] } {
    const where = ['service_id = ?'];
    const params: unknown[] = [serviceId];
    if (filter.since !== null) {
        where.push('checked_at >= ?');
        params.push(filter.since);
    }
    if (filter.failuresOnly) where.push('up = 0');
    return { where, params };
}

/** A raw ping seen as a one-sample chart point. */
function rawPoint(row: UptimeCheckRow): UptimePoint {
    const ms = row.response_ms === null ? null : Number(row.response_ms);
    return { at: Number(row.checked_at), checks: 1, upChecks: row.up === 1 ? 1 : 0, avgMs: ms, minMs: ms, maxMs: ms };
}

/** Shape of the GROUP BY used by both the hourly and the daily series. */
interface BucketRow {
    at: number;
    checks: number;
    up_checks: number;
    total_ms: number;
    ms_samples: number;
    min_ms: number | null;
    max_ms: number | null;
}

function bucketPoint(row: BucketRow): UptimePoint {
    const samples = Number(row.ms_samples);
    return {
        at: Number(row.at),
        checks: Number(row.checks),
        upChecks: Number(row.up_checks),
        avgMs: samples > 0 ? Math.round(Number(row.total_ms) / samples) : null,
        minMs: row.min_ms === null ? null : Number(row.min_ms),
        maxMs: row.max_ms === null ? null : Number(row.max_ms)
    };
}

/** Une ligne de `windowStats` / `dailyWindowStats`, avant conversion. */
interface WindowStatRow {
    service_id: number;
    checks: number;
    up_checks: number;
    total_ms: number;
    ms_samples: number;
}

function windowStat(row: WindowStatRow): UptimeWindowStat {
    const samples = Number(row.ms_samples);
    return {
        serviceId: Number(row.service_id),
        checks: Number(row.checks),
        upChecks: Number(row.up_checks),
        avgMs: samples > 0 ? Math.round(Number(row.total_ms) / samples) : null
    };
}

function servicesRepo(q: SdkQueryable): UptimeServicesRepo {
    async function reload(id: number, workspaceId: number): Promise<UptimeServiceRow | null> {
        const rows = await q.query<UptimeServiceRow>(
            'SELECT * FROM uptime_services WHERE id = ? AND workspace_id = ?',
            [id, workspaceId]
        );
        return rows[0] ?? null;
    }

    return {
        async countInWorkspaces(workspaceIds) {
            if (workspaceIds.length === 0) return 0;
            const rows = await q.query<{ n: number }>(
                'SELECT COUNT(*) AS n FROM uptime_services WHERE workspace_id IN (?)',
                [[...workspaceIds]]
            );
            return Number(rows[0]?.n ?? 0);
        },
        async listStock(workspaceIds) {
            if (workspaceIds.length === 0) return [];
            const rows = await q.query<{ id: number; workspace_id: number }>(
                'SELECT id, workspace_id FROM uptime_services WHERE workspace_id IN (?) ORDER BY created ASC, id ASC',
                [[...workspaceIds]]
            );
            return rows.map((row) => ({ id: String(row.id), workspaceId: Number(row.workspace_id) }));
        },
        async listVisible(workspaceId) {
            // `sort_order` appartient à l'espace d'origine : un service projeté
            // se range donc après les locaux, par identifiant. Lui donner un
            // ordre propre à chaque espace demanderait une colonne par
            // projection (un réglage d'affichage ne vaut pas cette table).
            return q.query<UptimeServiceRow>(
                `SELECT s.* FROM uptime_services s WHERE s.workspace_id = ?
                 UNION
                 SELECT s.* FROM uptime_services s
                   JOIN item_shares sh
                     ON sh.feature = 'uptime' AND sh.item_id = s.id AND sh.home_workspace_id = s.workspace_id
                  WHERE sh.workspace_id = ?
                 ORDER BY sort_order ASC, id ASC`,
                [workspaceId, workspaceId]
            );
        },
        async findVisible(id, workspaceId) {
            const rows = await q.query<UptimeServiceRow>(
                `SELECT s.* FROM uptime_services s
                  WHERE s.id = ?
                    AND (s.workspace_id = ?
                         OR EXISTS (SELECT 1 FROM item_shares sh
                                     WHERE sh.feature = 'uptime' AND sh.item_id = s.id
                                       AND sh.home_workspace_id = s.workspace_id
                                       AND sh.workspace_id = ?))`,
                [id, workspaceId, workspaceId]
            );
            return rows[0] ?? null;
        },
        async listByWorkspace(workspaceId) {
            // The user's own order; id only breaks ties.
            return q.query<UptimeServiceRow>(
                'SELECT * FROM uptime_services WHERE workspace_id = ? ORDER BY sort_order ASC, id ASC',
                [workspaceId]
            );
        },
        findById: reload,
        async create({ userId, workspaceId, integrityIntervalSeconds, ...config }) {
            // New services land at the end of the list, never in the middle.
            const posRows = await q.query<{ next: number }>(
                'SELECT COALESCE(MAX(sort_order) + 1, 0) AS next FROM uptime_services WHERE workspace_id = ?',
                [workspaceId]
            );
            const res = await q.execute(
                `INSERT INTO uptime_services
                     (user_id, workspace_id, content, method, expected_status, interval_seconds,
                      timeout_seconds, failure_threshold, retention_days, enabled, integrity_interval_seconds, sort_order)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [userId, workspaceId, ...configParams(config), integrityIntervalSeconds, Number(posRows[0]?.next ?? 0)]
            );
            const rows = await q.query<UptimeServiceRow>('SELECT * FROM uptime_services WHERE id = ?', [res.insertId]);
            return rows[0];
        },
        async update(id, workspaceId, config) {
            const res = await q.execute(
                `UPDATE uptime_services SET ${SERVICE_COLUMNS} WHERE id = ? AND workspace_id = ?`,
                [...configParams(config), id, workspaceId]
            );
            if (res.affectedRows === 0) return null;
            return reload(id, workspaceId);
        },
        async setIntegrity(id, workspaceId, { content, integrityIntervalSeconds }) {
            const res = await q.execute(
                'UPDATE uptime_services SET content = ?, integrity_interval_seconds = ? WHERE id = ? AND workspace_id = ?',
                [content, integrityIntervalSeconds, id, workspaceId]
            );
            if (res.affectedRows === 0) return null;
            return reload(id, workspaceId);
        },
        async setEnabled(id, workspaceId, enabled) {
            // Resuming clears the failure streak: the next probe decides afresh
            // rather than inheriting a count from before the pause.
            const res = await q.execute(
                `UPDATE uptime_services SET enabled = ?, consecutive_failures = IF(?, 0, consecutive_failures)
                 WHERE id = ? AND workspace_id = ?`,
                [enabled ? 1 : 0, enabled ? 1 : 0, id, workspaceId]
            );
            if (res.affectedRows === 0) return null;
            return reload(id, workspaceId);
        },
        async delete(id, workspaceId) {
            const res = await q.execute('DELETE FROM uptime_services WHERE id = ? AND workspace_id = ?', [
                id,
                workspaceId
            ]);
            return res.affectedRows > 0;
        },
        async reorder(workspaceId, ids) {
            // Rank by index; rows the user doesn't own are silently ignored.
            // Probe state is untouched: repositioning is not a configuration change.
            for (let i = 0; i < ids.length; i++) {
                await q.execute('UPDATE uptime_services SET sort_order = ? WHERE id = ? AND workspace_id = ?', [
                    i,
                    ids[i],
                    workspaceId
                ]);
            }
        },
        async listDue(now, limit, planPaused) {
            // `NOT IN ()` n'est pas du SQL : la clause n'existe qu'avec des pauses.
            const skip = planPaused.length > 0;
            return q.query<UptimeServiceRow>(
                `SELECT * FROM uptime_services
                 WHERE enabled = 1 AND (last_checked_at IS NULL OR last_checked_at + interval_seconds <= ?)
                 ${skip ? 'AND id NOT IN (?)' : ''}
                 ORDER BY last_checked_at IS NOT NULL, last_checked_at ASC
                 LIMIT ?`,
                skip ? [now, [...planPaused], limit] : [now, limit]
            );
        },
        async recordIntegrity(id, reading) {
            await q.execute(
                `UPDATE uptime_services
                 SET integrity_checked_at = ?, integrity_failures = ?, integrity_verdict = ?,
                     baseline_enc = COALESCE(?, baseline_enc), integrity_pending_since = ?
                 WHERE id = ?`,
                [reading.checkedAt, reading.failures, reading.verdict, reading.baseline, reading.pendingSince, id]
            );
        },
        async resetIntegrity(id) {
            await q.execute(
                `UPDATE uptime_services
                 SET baseline_enc = NULL, integrity_checked_at = NULL, integrity_failures = 0, integrity_verdict = NULL,
                     integrity_pending_since = NULL
                 WHERE id = ?`,
                [id]
            );
        },
        async listDeploySources(serviceIds) {
            if (serviceIds.length === 0) return [];
            return q.query<UptimeDeploySourceRow>(
                `SELECT service_id, kind, ref_id FROM ft_uptime_deploy_sources
                 WHERE service_id IN (?) ORDER BY service_id ASC, position ASC`,
                [[...serviceIds]]
            );
        },
        async setDeploySources(serviceId, sources) {
            await q.execute('DELETE FROM ft_uptime_deploy_sources WHERE service_id = ?', [serviceId]);
            for (const [position, source] of sources.entries()) {
                await q.execute(
                    'INSERT INTO ft_uptime_deploy_sources (service_id, kind, ref_id, position) VALUES (?, ?, ?, ?)',
                    [serviceId, source.kind, source.id, position]
                );
            }
        },
        async setDeployHook(serviceId, hook) {
            await q.execute(
                `UPDATE uptime_services SET deploy_hook_hash = ?, deploy_hook_enc = ?, deploy_hook_at = NULL
                 WHERE id = ?`,
                [hook?.hash ?? null, hook?.enc ?? null, serviceId]
            );
        },
        async findByDeployHook(hash) {
            const rows = await q.query<UptimeServiceRow>('SELECT * FROM uptime_services WHERE deploy_hook_hash = ?', [
                hash
            ]);
            return rows[0] ?? null;
        },
        async markDeployHookCalled(serviceId, at) {
            await q.execute('UPDATE uptime_services SET deploy_hook_at = ? WHERE id = ?', [at, serviceId]);
        },
        async recordProbe(id, result) {
            await q.execute(
                `UPDATE uptime_services
                 SET status = ?, consecutive_failures = ?, last_checked_at = ?,
                     last_response_ms = ?, last_http_status = ?, last_error = ?
                 WHERE id = ?`,
                [
                    result.status,
                    result.consecutiveFailures,
                    result.checkedAt,
                    result.responseMs,
                    result.httpStatus,
                    result.error,
                    id
                ]
            );
        }
    };
}

function historyRepo(q: SdkQueryable): UptimeHistoryRepo {
    return {
        async addCheck({ serviceId, checkedAt, up, httpStatus, responseMs, error }) {
            await q.execute(
                `INSERT INTO uptime_checks (service_id, checked_at, up, http_status, response_ms, error)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [serviceId, checkedAt, up ? 1 : 0, httpStatus, responseMs, error]
            );
            // Fold into the day's rollup in the same breath, so the long-range
            // series stays exact even once the raw rows are pruned. LEAST/GREATEST
            // ignore a NULL side, which is what a failed ping (no latency) needs.
            const day = Math.floor(checkedAt / 86400) * 86400;
            const ms = responseMs;
            await q.execute(
                `INSERT INTO uptime_daily (service_id, day, checks, up_checks, total_ms, ms_samples, min_ms, max_ms)
                 VALUES (?, ?, 1, ?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE
                     checks     = checks + 1,
                     up_checks  = up_checks + VALUES(up_checks),
                     total_ms   = total_ms + VALUES(total_ms),
                     ms_samples = ms_samples + VALUES(ms_samples),
                     min_ms     = LEAST(COALESCE(min_ms, VALUES(min_ms)), COALESCE(VALUES(min_ms), min_ms)),
                     max_ms     = GREATEST(COALESCE(max_ms, VALUES(max_ms)), COALESCE(VALUES(max_ms), max_ms))`,
                [serviceId, day, up ? 1 : 0, ms ?? 0, ms === null ? 0 : 1, ms, ms]
            );
        },
        async listChecks(serviceId, filter, limit, before) {
            const { where, params } = checkFilterSql(serviceId, filter);
            if (before !== undefined) {
                where.push('checked_at < ?');
                params.push(before);
            }
            return q.query<UptimeCheckRow>(
                `SELECT * FROM uptime_checks WHERE ${where.join(' AND ')}
                 ORDER BY checked_at DESC, id DESC
                 LIMIT ?`,
                [...params, limit]
            );
        },
        async checkStats(serviceId, filter) {
            const { where, params } = checkFilterSql(serviceId, filter);
            const rows = await q.query<{
                count: number;
                failures: number;
                total_ms: number;
                ms_samples: number;
                min_ms: number | null;
                max_ms: number | null;
                first_at: number | null;
                last_at: number | null;
            }>(
                `SELECT COUNT(*)                    AS count,
                        SUM(up = 0)                 AS failures,
                        COALESCE(SUM(response_ms), 0) AS total_ms,
                        COUNT(response_ms)          AS ms_samples,
                        MIN(response_ms)            AS min_ms,
                        MAX(response_ms)            AS max_ms,
                        MIN(checked_at)             AS first_at,
                        MAX(checked_at)             AS last_at
                 FROM uptime_checks WHERE ${where.join(' AND ')}`,
                params
            );
            const row = rows[0];
            const samples = Number(row?.ms_samples ?? 0);
            return {
                count: Number(row?.count ?? 0),
                failures: Number(row?.failures ?? 0),
                avgMs: samples > 0 ? Math.round(Number(row?.total_ms ?? 0) / samples) : null,
                minMs: row?.min_ms === null || row?.min_ms === undefined ? null : Number(row.min_ms),
                maxMs: row?.max_ms === null || row?.max_ms === undefined ? null : Number(row.max_ms),
                firstAt: row?.first_at === null || row?.first_at === undefined ? null : Number(row.first_at),
                lastAt: row?.last_at === null || row?.last_at === undefined ? null : Number(row.last_at)
            };
        },
        async rawPoints(serviceId, since, limit) {
            // Selected newest-first so the cap bites on the far end of the
            // window, then flipped back to chronological order for the chart.
            const rows = await q.query<UptimeCheckRow>(
                `SELECT * FROM uptime_checks WHERE service_id = ? AND checked_at >= ?
                 ORDER BY checked_at DESC, id DESC LIMIT ?`,
                [serviceId, since, limit]
            );
            return rows.reverse().map(rawPoint);
        },
        async hourlyPoints(serviceId, since) {
            const rows = await q.query<BucketRow>(
                `SELECT (checked_at DIV 3600) * 3600 AS at,
                        COUNT(*)                     AS checks,
                        SUM(up)                      AS up_checks,
                        COALESCE(SUM(response_ms), 0) AS total_ms,
                        COUNT(response_ms)           AS ms_samples,
                        MIN(response_ms)             AS min_ms,
                        MAX(response_ms)             AS max_ms
                 FROM uptime_checks
                 WHERE service_id = ? AND checked_at >= ?
                 GROUP BY at
                 ORDER BY at ASC`,
                [serviceId, since]
            );
            return rows.map(bucketPoint);
        },
        async dailyPoints(serviceId, since) {
            const rows = await q.query<BucketRow>(
                `SELECT day AS at, checks, up_checks, total_ms, ms_samples, min_ms, max_ms
                 FROM uptime_daily
                 WHERE service_id = ? AND day >= ?
                 ORDER BY day ASC`,
                [serviceId, since]
            );
            return rows.map(bucketPoint);
        },
        async windowStats(workspaceId, since) {
            const rows = await q.query<WindowStatRow>(
                `SELECT c.service_id,
                        COUNT(*)                        AS checks,
                        SUM(c.up)                       AS up_checks,
                        COALESCE(SUM(c.response_ms), 0) AS total_ms,
                        COUNT(c.response_ms)            AS ms_samples
                 FROM uptime_checks c
                 JOIN uptime_services s ON s.id = c.service_id
                 WHERE s.workspace_id = ? AND c.checked_at >= ?
                 GROUP BY c.service_id`,
                [workspaceId, since]
            );
            return rows.map(windowStat);
        },
        async dailyWindowStats(workspaceId, sinceDay) {
            const rows = await q.query<WindowStatRow>(
                `SELECT d.service_id,
                        SUM(d.checks)     AS checks,
                        SUM(d.up_checks)  AS up_checks,
                        SUM(d.total_ms)   AS total_ms,
                        SUM(d.ms_samples) AS ms_samples
                 FROM uptime_daily d
                 JOIN uptime_services s ON s.id = d.service_id
                 WHERE s.workspace_id = ? AND d.day >= ?
                 GROUP BY d.service_id`,
                [workspaceId, sinceDay]
            );
            return rows.map(windowStat);
        },
        async openIncident(serviceId) {
            const rows = await q.query<UptimeIncidentRow>(
                'SELECT * FROM uptime_incidents WHERE service_id = ? AND ended_at IS NULL ORDER BY started_at DESC',
                [serviceId]
            );
            return rows[0] ?? null;
        },
        async listOpenIncidents(workspaceId) {
            return q.query<UptimeIncidentRow>(
                `SELECT i.* FROM uptime_incidents i
                 JOIN uptime_services s ON s.id = i.service_id
                 WHERE s.workspace_id = ? AND i.ended_at IS NULL`,
                [workspaceId]
            );
        },
        async openIncidentAt({ serviceId, startedAt, httpStatus, error }) {
            const res = await q.execute(
                'INSERT INTO uptime_incidents (service_id, started_at, http_status, error) VALUES (?, ?, ?, ?)',
                [serviceId, startedAt, httpStatus, error]
            );
            const rows = await q.query<UptimeIncidentRow>('SELECT * FROM uptime_incidents WHERE id = ?', [
                res.insertId
            ]);
            return rows[0];
        },
        async markIncidentNotified(id) {
            await q.execute('UPDATE uptime_incidents SET notified = 1 WHERE id = ?', [id]);
        },
        async closeIncident(id, endedAt) {
            await q.execute('UPDATE uptime_incidents SET ended_at = ? WHERE id = ? AND ended_at IS NULL', [
                endedAt,
                id
            ]);
        },
        async listIncidents(serviceId, limit) {
            return q.query<UptimeIncidentRow>(
                'SELECT * FROM uptime_incidents WHERE service_id = ? ORDER BY started_at DESC LIMIT ?',
                [serviceId, limit]
            );
        },
        async addReading({ serviceId, checkedAt, outcome, fileCount, slowestMs, detail }) {
            await q.execute(
                `INSERT INTO ft_uptime_integrity_readings (service_id, checked_at, outcome, file_count, slowest_ms, detail)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [serviceId, checkedAt, outcome, fileCount, slowestMs, detail]
            );
        },
        async listReadings(serviceId, limit, before) {
            return q.query<UptimeIntegrityReadingRow>(
                `SELECT * FROM ft_uptime_integrity_readings
                 WHERE service_id = ? ${before === undefined ? '' : 'AND checked_at < ?'}
                 ORDER BY checked_at DESC, id DESC
                 LIMIT ?`,
                before === undefined ? [serviceId, limit] : [serviceId, before, limit]
            );
        },
        async lastConformAt(serviceId) {
            const rows = await q.query<{ at: number | null }>(
                `SELECT MAX(checked_at) AS at FROM ft_uptime_integrity_readings
                 WHERE service_id = ? AND outcome IN ('learned', 'conform')`,
                [serviceId]
            );
            const at = rows[0]?.at;
            return at === null || at === undefined ? null : Number(at);
        },
        async pruneByRetention(now) {
            const checks = await q.execute(
                `DELETE c FROM uptime_checks c
                 JOIN uptime_services s ON s.id = c.service_id
                 WHERE s.retention_days IS NOT NULL AND c.checked_at < ? - s.retention_days * 86400`,
                [now]
            );
            const readings = await q.execute(
                `DELETE r FROM ft_uptime_integrity_readings r
                 JOIN uptime_services s ON s.id = r.service_id
                 WHERE s.retention_days IS NOT NULL AND r.checked_at < ? - s.retention_days * 86400`,
                [now]
            );
            return { checks: checks.affectedRows, readings: readings.affectedRows };
        }
    };
}

export function createRepo(q: SdkQueryable): UptimeRepo {
    return {
        services: servicesRepo(q),
        history: historyRepo(q),
        pages: createPagesRepo(q),
        status: createStatusRepo(q)
    };
}
