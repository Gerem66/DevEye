import type { SdkQueryable, SdkStockItem } from '@deveye/types/sdk/server';

/** Une ligne de lien, telle que la base la rend. */
export interface LinkRow {
    id: number;
    workspace_id: number;
    user_id: number | null;
    code: string;
    domain_id: number | null;
    slug: string | null;
    content: string;
    password_hash: string | null;
    expires_at: number | null;
    max_visits: number | null;
    visits_total: number;
    clicks_total: number;
    enabled: number;
    blocked_at: number | null;
    blocked_reason: string | null;
    check_enabled: number;
    check_state: string;
    check_error: string | null;
    checked_at: number | null;
    check_due: number | null;
    created: number;
    updated: number;
}

const LINK_COLUMNS = `id, workspace_id, user_id, code, domain_id, slug, content, password_hash, expires_at, max_visits,
    visits_total, clicks_total, enabled, blocked_at, blocked_reason, check_enabled, check_state, check_error,
    checked_at, check_due, created, updated`;

const OF_LINK = `l.id, l.workspace_id, l.user_id, l.code, l.domain_id, l.slug, l.content, l.password_hash, l.expires_at,
    l.max_visits, l.visits_total, l.clicks_total, l.enabled, l.blocked_at, l.blocked_reason, l.check_enabled,
    l.check_state, l.check_error, l.checked_at, l.check_due, l.created, l.updated`;

export interface DailyDelta {
    linkId: number;
    day: number;
    clicks: number;
    visits: number;
    bots: number;
}

export interface DimDelta {
    linkId: number;
    day: number;
    kind: string;
    value: string;
    visits: number;
}

export interface ReportRow {
    id: number;
    ref: string;
    link_id: number | null;
    workspace_id: number | null;
    reason: string;
    content: string;
    status: 'open' | 'dismissed' | 'actioned';
    decision: string;
    handled_by: number | null;
    created: number;
    closed_at: number | null;
    /** Le lien est retiré par l'administration, au moment de la lecture. */
    link_blocked_at: number | null;
}

const REPORT_COLUMNS = `r.id, r.ref, r.link_id, r.workspace_id, r.reason, r.content, r.status, r.decision, r.handled_by,
    r.created, r.closed_at, l.blocked_at AS link_blocked_at`;

export interface ShortlinksRepo {
    links: {
        /** Les liens de l'espace et ceux qu'un autre espace y projette, les plus récents d'abord. */
        listVisible(workspaceId: number): Promise<LinkRow[]>;
        findVisible(id: number, workspaceId: number): Promise<LinkRow | null>;
        /** Où qu'il soit : pour la modération et le service, jamais pour un membre. */
        findById(id: number): Promise<LinkRow | null>;
        findByCode(code: string): Promise<LinkRow | null>;
        findBySlug(domainId: number, slug: string): Promise<LinkRow | null>;
        countIn(workspaceIds: readonly number[]): Promise<number>;
        /** Les plus anciens d'abord : c'est l'excédent le plus récent que l'offre met en pause. */
        listStock(workspaceIds: readonly number[]): Promise<SdkStockItem[]>;
        create(input: {
            workspaceId: number;
            userId: number;
            code: string;
            domainId: number | null;
            slug: string | null;
            content: string;
            at: number;
        }): Promise<number>;
        update(
            id: number,
            workspaceId: number,
            input: { content: string; domainId: number | null; slug: string | null; checkEnabled: boolean; at: number }
        ): Promise<void>;
        updateContent(id: number, workspaceId: number, content: string, at: number): Promise<void>;
        /** `passwordHash` absent : le mot de passe ne change pas. */
        updateAccess(
            id: number,
            workspaceId: number,
            input: { passwordHash?: string | null; expiresAt: number | null; maxVisits: number | null; at: number }
        ): Promise<void>;
        setEnabled(id: number, workspaceId: number, enabled: boolean, at: number): Promise<void>;
        remove(id: number, workspaceId: number): Promise<boolean>;
        /** Les liens qui l'utilisaient gardent leur adresse sur DevEye ; rend leurs identifiants. */
        clearDomain(domainId: number, workspaceId: number): Promise<number[]>;
        domainUse(workspaceId: number): Promise<ReadonlyMap<number, number>>;
        block(id: number, at: number, reason: string): Promise<void>;
        unblock(id: number): Promise<void>;
        /** `state` absent : un premier échec, que la vérification de `due` confirmera ou non. */
        saveCheck(
            id: number,
            verdict: { state?: 'ok' | 'broken'; error: string | null; at: number; due: number }
        ): Promise<void>;
        /** Les liens dont la vérification est due à `at`, les plus en retard d'abord. */
        dueChecks(at: number, limit: number): Promise<LinkRow[]>;
        addTotals(id: number, clicks: number, visits: number): Promise<void>;
    };
    stats: {
        /** Visites par lien et par jour, à partir de `fromDay` : la petite courbe de la liste. */
        recent(
            linkIds: readonly number[],
            fromDay: number
        ): Promise<{ link_id: number; day: number; visits: number }[]>;
        series(
            linkIds: readonly number[],
            fromDay: number,
            toDay: number
        ): Promise<{ day: number; clicks: number; visits: number; bots: number }[]>;
        dims(
            linkIds: readonly number[],
            kind: string,
            fromDay: number,
            toDay: number,
            limit: number
        ): Promise<{ value: string; visits: number }[]>;
        labels(ids: readonly number[]): Promise<{ id: number; workspace_id: number; content: string }[]>;
        visitsOn(linkIds: readonly number[], day: number): Promise<number>;
    };
    counters: {
        /** Vrai quand cette personne n'avait pas encore été comptée ce jour-là sur ce lien. */
        markSeen(day: number, linkId: number, visitorRef: string): Promise<boolean>;
        addDaily(rows: readonly DailyDelta[]): Promise<void>;
        addDims(rows: readonly DimDelta[]): Promise<void>;
        /** Ajoute au mois de l'espace, et rend son total et le dernier seuil d'avis franchi. */
        addUsage(workspaceId: number, month: string, visits: number): Promise<{ visits: number; notified: number }>;
        setNotified(workspaceId: number, month: string, level: number): Promise<void>;
        monthlyVisits(workspaceIds: readonly number[], month: string): Promise<number>;
        resolveLabel(workspaceId: number, kind: string, labelRef: string, content: string): Promise<number>;
        purgeSeen(beforeDay: number): Promise<void>;
        purgeDims(beforeDay: number): Promise<void>;
    };
    reports: {
        insert(row: {
            ref: string;
            linkId: number;
            workspaceId: number;
            reason: string;
            content: string;
        }): Promise<void>;
        find(id: number): Promise<ReportRow | null>;
        list(status: 'open' | 'closed', limit: number): Promise<ReportRow[]>;
        countOpen(): Promise<number>;
        countSince(since: number): Promise<number>;
        close(
            id: number,
            status: 'dismissed' | 'actioned',
            decision: string,
            handledBy: number,
            at: number
        ): Promise<void>;
        purge(before: number): Promise<void>;
    };
}

export function createRepo(q: SdkQueryable): ShortlinksRepo {
    const one = async <T extends object>(sql: string, params: unknown[]): Promise<T | null> =>
        (await q.query<T>(sql, params))[0] ?? null;

    return {
        links: {
            listVisible(workspaceId) {
                return q.query<LinkRow>(
                    `SELECT ${OF_LINK} FROM ft_shortlinks_links l WHERE l.workspace_id = ?
                     UNION
                     SELECT ${OF_LINK} FROM ft_shortlinks_links l
                       JOIN item_shares sh
                         ON sh.feature = 'shortlinks' AND sh.item_id = l.id AND sh.home_workspace_id = l.workspace_id
                      WHERE sh.workspace_id = ?
                     ORDER BY created DESC, id DESC`,
                    [workspaceId, workspaceId]
                );
            },
            findVisible(id, workspaceId) {
                return one<LinkRow>(
                    `SELECT ${OF_LINK} FROM ft_shortlinks_links l
                      WHERE l.id = ?
                        AND (l.workspace_id = ?
                             OR EXISTS (SELECT 1 FROM item_shares sh
                                         WHERE sh.feature = 'shortlinks' AND sh.item_id = l.id
                                           AND sh.home_workspace_id = l.workspace_id
                                           AND sh.workspace_id = ?))`,
                    [id, workspaceId, workspaceId]
                );
            },
            findById(id) {
                return one<LinkRow>(`SELECT ${LINK_COLUMNS} FROM ft_shortlinks_links WHERE id = ?`, [id]);
            },
            findByCode(code) {
                return one<LinkRow>(`SELECT ${LINK_COLUMNS} FROM ft_shortlinks_links WHERE code = ?`, [code]);
            },
            findBySlug(domainId, slug) {
                return one<LinkRow>(
                    `SELECT ${LINK_COLUMNS} FROM ft_shortlinks_links WHERE domain_id = ? AND slug = ?`,
                    [domainId, slug]
                );
            },
            async countIn(workspaceIds) {
                if (workspaceIds.length === 0) return 0;
                const rows = await q.query<{ total: number }>(
                    'SELECT COUNT(*) AS total FROM ft_shortlinks_links WHERE workspace_id IN (?)',
                    [[...workspaceIds]]
                );
                return Number(rows[0]?.total ?? 0);
            },
            async listStock(workspaceIds) {
                if (workspaceIds.length === 0) return [];
                const rows = await q.query<{ id: number; workspace_id: number }>(
                    'SELECT id, workspace_id FROM ft_shortlinks_links WHERE workspace_id IN (?) ORDER BY created ASC, id ASC',
                    [[...workspaceIds]]
                );
                return rows.map((row) => ({ id: String(row.id), workspaceId: Number(row.workspace_id) }));
            },
            async create(input) {
                const res = await q.execute(
                    `INSERT INTO ft_shortlinks_links (workspace_id, user_id, code, domain_id, slug, content, created, updated)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                    [
                        input.workspaceId,
                        input.userId,
                        input.code,
                        input.domainId,
                        input.slug,
                        input.content,
                        input.at,
                        input.at
                    ]
                );
                return Number(res.insertId);
            },
            async update(id, workspaceId, input) {
                await q.execute(
                    `UPDATE ft_shortlinks_links SET content = ?, domain_id = ?, slug = ?, check_enabled = ?, updated = ?
                      WHERE id = ? AND workspace_id = ?`,
                    [input.content, input.domainId, input.slug, input.checkEnabled ? 1 : 0, input.at, id, workspaceId]
                );
            },
            async updateContent(id, workspaceId, content, at) {
                await q.execute(
                    'UPDATE ft_shortlinks_links SET content = ?, updated = ? WHERE id = ? AND workspace_id = ?',
                    [content, at, id, workspaceId]
                );
            },
            async updateAccess(id, workspaceId, input) {
                if (input.passwordHash === undefined) {
                    await q.execute(
                        `UPDATE ft_shortlinks_links SET expires_at = ?, max_visits = ?, updated = ?
                          WHERE id = ? AND workspace_id = ?`,
                        [input.expiresAt, input.maxVisits, input.at, id, workspaceId]
                    );
                    return;
                }
                await q.execute(
                    `UPDATE ft_shortlinks_links SET password_hash = ?, expires_at = ?, max_visits = ?, updated = ?
                      WHERE id = ? AND workspace_id = ?`,
                    [input.passwordHash, input.expiresAt, input.maxVisits, input.at, id, workspaceId]
                );
            },
            async setEnabled(id, workspaceId, enabled, at) {
                await q.execute(
                    'UPDATE ft_shortlinks_links SET enabled = ?, updated = ? WHERE id = ? AND workspace_id = ?',
                    [enabled ? 1 : 0, at, id, workspaceId]
                );
            },
            async remove(id, workspaceId) {
                const res = await q.execute('DELETE FROM ft_shortlinks_links WHERE id = ? AND workspace_id = ?', [
                    id,
                    workspaceId
                ]);
                return res.affectedRows > 0;
            },
            async clearDomain(domainId, workspaceId) {
                const rows = await q.query<{ id: number }>(
                    'SELECT id FROM ft_shortlinks_links WHERE domain_id = ? AND workspace_id = ?',
                    [domainId, workspaceId]
                );
                await q.execute(
                    'UPDATE ft_shortlinks_links SET domain_id = NULL, slug = NULL WHERE domain_id = ? AND workspace_id = ?',
                    [domainId, workspaceId]
                );
                return rows.map((row) => Number(row.id));
            },
            async domainUse(workspaceId) {
                const rows = await q.query<{ domain_id: number; uses: number }>(
                    `SELECT domain_id, COUNT(*) AS uses FROM ft_shortlinks_links
                      WHERE workspace_id = ? AND domain_id IS NOT NULL GROUP BY domain_id`,
                    [workspaceId]
                );
                return new Map(rows.map((row) => [Number(row.domain_id), Number(row.uses)]));
            },
            async block(id, at, reason) {
                await q.execute('UPDATE ft_shortlinks_links SET blocked_at = ?, blocked_reason = ? WHERE id = ?', [
                    at,
                    reason,
                    id
                ]);
            },
            async unblock(id) {
                await q.execute(
                    'UPDATE ft_shortlinks_links SET blocked_at = NULL, blocked_reason = NULL WHERE id = ?',
                    [id]
                );
            },
            async saveCheck(id, verdict) {
                if (verdict.state === undefined) {
                    await q.execute('UPDATE ft_shortlinks_links SET check_due = ? WHERE id = ?', [verdict.due, id]);
                    return;
                }
                await q.execute(
                    `UPDATE ft_shortlinks_links SET check_state = ?, check_error = ?, checked_at = ?, check_due = ?
                      WHERE id = ?`,
                    [verdict.state, verdict.error, verdict.at, verdict.due, id]
                );
            },
            dueChecks(at, limit) {
                return q.query<LinkRow>(
                    `SELECT ${LINK_COLUMNS} FROM ft_shortlinks_links
                      WHERE check_enabled = 1 AND enabled = 1 AND blocked_at IS NULL
                        AND (check_due IS NULL OR check_due <= ?)
                      ORDER BY check_due IS NULL DESC, check_due ASC, id ASC
                      LIMIT ?`,
                    [at, limit]
                );
            },
            async addTotals(id, clicks, visits) {
                await q.execute(
                    'UPDATE ft_shortlinks_links SET clicks_total = clicks_total + ?, visits_total = visits_total + ? WHERE id = ?',
                    [clicks, visits, id]
                );
            }
        },
        stats: {
            async recent(linkIds, fromDay) {
                if (linkIds.length === 0) return [];
                const rows = await q.query<{ link_id: number; day: number; visits: number }>(
                    'SELECT link_id, day, visits FROM ft_shortlinks_daily WHERE link_id IN (?) AND day >= ?',
                    [[...linkIds], fromDay]
                );
                return rows.map((row) => ({
                    link_id: Number(row.link_id),
                    day: Number(row.day),
                    visits: Number(row.visits)
                }));
            },
            async series(linkIds, fromDay, toDay) {
                if (linkIds.length === 0) return [];
                const rows = await q.query<{ day: number; clicks: number; visits: number; bots: number }>(
                    `SELECT day, SUM(clicks) AS clicks, SUM(visits) AS visits, SUM(bots) AS bots
                       FROM ft_shortlinks_daily
                      WHERE link_id IN (?) AND day >= ? AND day <= ?
                      GROUP BY day`,
                    [[...linkIds], fromDay, toDay]
                );
                return rows.map((row) => ({
                    day: Number(row.day),
                    clicks: Number(row.clicks),
                    visits: Number(row.visits),
                    bots: Number(row.bots)
                }));
            },
            async dims(linkIds, kind, fromDay, toDay, limit) {
                if (linkIds.length === 0) return [];
                const rows = await q.query<{ value: string; visits: number }>(
                    `SELECT value, SUM(visits) AS visits FROM ft_shortlinks_dims
                      WHERE link_id IN (?) AND kind = ? AND day >= ? AND day <= ?
                      GROUP BY value ORDER BY visits DESC, value ASC LIMIT ?`,
                    [[...linkIds], kind, fromDay, toDay, limit]
                );
                return rows.map((row) => ({ value: String(row.value), visits: Number(row.visits) }));
            },
            async labels(ids) {
                if (ids.length === 0) return [];
                return q.query<{ id: number; workspace_id: number; content: string }>(
                    'SELECT id, workspace_id, content FROM ft_shortlinks_labels WHERE id IN (?)',
                    [[...ids]]
                );
            },
            async visitsOn(linkIds, day) {
                if (linkIds.length === 0) return 0;
                const rows = await q.query<{ total: number | null }>(
                    'SELECT COALESCE(SUM(visits), 0) AS total FROM ft_shortlinks_daily WHERE link_id IN (?) AND day = ?',
                    [[...linkIds], day]
                );
                return Number(rows[0]?.total ?? 0);
            }
        },
        counters: {
            async markSeen(day, linkId, visitorRef) {
                const res = await q.execute(
                    'INSERT IGNORE INTO ft_shortlinks_seen (day, link_id, visitor_ref) VALUES (?, ?, ?)',
                    [day, linkId, visitorRef]
                );
                return res.affectedRows === 1;
            },
            async addDaily(rows) {
                if (rows.length === 0) return;
                const placeholders = rows.map(() => '(?, ?, ?, ?, ?)').join(', ');
                await q.execute(
                    `INSERT INTO ft_shortlinks_daily (link_id, day, clicks, visits, bots) VALUES ${placeholders}
                     ON DUPLICATE KEY UPDATE clicks = clicks + VALUES(clicks), visits = visits + VALUES(visits),
                                             bots = bots + VALUES(bots)`,
                    rows.flatMap((row) => [row.linkId, row.day, row.clicks, row.visits, row.bots])
                );
            },
            async addDims(rows) {
                if (rows.length === 0) return;
                const placeholders = rows.map(() => '(?, ?, ?, ?, ?)').join(', ');
                await q.execute(
                    `INSERT INTO ft_shortlinks_dims (link_id, day, kind, value, visits) VALUES ${placeholders}
                     ON DUPLICATE KEY UPDATE visits = visits + VALUES(visits)`,
                    rows.flatMap((row) => [row.linkId, row.day, row.kind, row.value, row.visits])
                );
            },
            async addUsage(workspaceId, month, visits) {
                await q.execute(
                    `INSERT INTO ft_shortlinks_usage (workspace_id, month, visits) VALUES (?, ?, ?)
                     ON DUPLICATE KEY UPDATE visits = visits + VALUES(visits)`,
                    [workspaceId, month, visits]
                );
                const row = await one<{ visits: number; notified: number }>(
                    'SELECT visits, notified FROM ft_shortlinks_usage WHERE workspace_id = ? AND month = ?',
                    [workspaceId, month]
                );
                return { visits: Number(row?.visits ?? 0), notified: Number(row?.notified ?? 0) };
            },
            async setNotified(workspaceId, month, level) {
                await q.execute('UPDATE ft_shortlinks_usage SET notified = ? WHERE workspace_id = ? AND month = ?', [
                    level,
                    workspaceId,
                    month
                ]);
            },
            async monthlyVisits(workspaceIds, month) {
                if (workspaceIds.length === 0) return 0;
                const rows = await q.query<{ total: number | null }>(
                    `SELECT COALESCE(SUM(visits), 0) AS total FROM ft_shortlinks_usage
                      WHERE workspace_id IN (?) AND month = ?`,
                    [[...workspaceIds], month]
                );
                return Number(rows[0]?.total ?? 0);
            },
            async resolveLabel(workspaceId, kind, labelRef, content) {
                const res = await q.execute(
                    `INSERT INTO ft_shortlinks_labels (workspace_id, kind, label_ref, content) VALUES (?, ?, ?, ?)
                     ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)`,
                    [workspaceId, kind, labelRef, content]
                );
                return Number(res.insertId);
            },
            async purgeSeen(beforeDay) {
                await q.execute('DELETE FROM ft_shortlinks_seen WHERE day < ?', [beforeDay]);
            },
            async purgeDims(beforeDay) {
                await q.execute('DELETE FROM ft_shortlinks_dims WHERE day < ?', [beforeDay]);
            }
        },
        reports: {
            async insert(row) {
                await q.execute(
                    `INSERT INTO ft_shortlinks_reports (ref, link_id, workspace_id, reason, content)
                     VALUES (?, ?, ?, ?, ?)`,
                    [row.ref, row.linkId, row.workspaceId, row.reason, row.content]
                );
            },
            find(id) {
                return one<ReportRow>(
                    `SELECT ${REPORT_COLUMNS} FROM ft_shortlinks_reports r
                       LEFT JOIN ft_shortlinks_links l ON l.id = r.link_id
                      WHERE r.id = ?`,
                    [id]
                );
            },
            list(status, limit) {
                return status === 'open'
                    ? q.query<ReportRow>(
                          `SELECT ${REPORT_COLUMNS} FROM ft_shortlinks_reports r
                             LEFT JOIN ft_shortlinks_links l ON l.id = r.link_id
                            WHERE r.status = 'open' ORDER BY r.created ASC, r.id ASC LIMIT ?`,
                          [limit]
                      )
                    : q.query<ReportRow>(
                          `SELECT ${REPORT_COLUMNS} FROM ft_shortlinks_reports r
                             LEFT JOIN ft_shortlinks_links l ON l.id = r.link_id
                            WHERE r.status <> 'open' ORDER BY r.closed_at DESC, r.id DESC LIMIT ?`,
                          [limit]
                      );
            },
            async countOpen() {
                const rows = await q.query<{ total: number }>(
                    "SELECT COUNT(*) AS total FROM ft_shortlinks_reports WHERE status = 'open'",
                    []
                );
                return Number(rows[0]?.total ?? 0);
            },
            async countSince(since) {
                const rows = await q.query<{ total: number }>(
                    'SELECT COUNT(*) AS total FROM ft_shortlinks_reports WHERE created >= ?',
                    [since]
                );
                return Number(rows[0]?.total ?? 0);
            },
            async close(id, status, decision, handledBy, at) {
                await q.execute(
                    `UPDATE ft_shortlinks_reports SET status = ?, decision = ?, handled_by = ?, closed_at = ?
                      WHERE id = ? AND status = 'open'`,
                    [status, decision, handledBy, at, id]
                );
            },
            async purge(before) {
                await q.execute("DELETE FROM ft_shortlinks_reports WHERE status <> 'open' AND closed_at < ?", [before]);
            }
        }
    };
}
