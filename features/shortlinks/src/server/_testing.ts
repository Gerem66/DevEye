import type { DailyDelta, DimDelta, LinkRow, ReportRow, ShortlinksRepo } from './repo';

/**
 * Un dépôt en mémoire, pour les tests : les mêmes règles que les requêtes
 * (unicité du code et de l'alias par domaine, `INSERT IGNORE` des empreintes,
 * sommes des compteurs), sans base.
 */

export interface MemoryRepo extends ShortlinksRepo {
    rows: LinkRow[];
    daily: Map<string, DailyDelta>;
    dims: Map<string, DimDelta>;
    seen: Set<string>;
    usage: Map<string, { visits: number; notified: number }>;
    labelRows: { id: number; workspace_id: number; kind: string; label_ref: string; content: string }[];
    reportRows: ReportRow[];
}

const duplicate = (key: string) =>
    Object.assign(new Error(`Duplicate entry for key '${key}'`), { code: 'ER_DUP_ENTRY' });

export function linkRow(over: Partial<LinkRow> & { id: number }): LinkRow {
    return {
        workspace_id: 1,
        user_id: 1,
        code: 'abcdef',
        domain_id: null,
        slug: null,
        content: JSON.stringify({
            title: 'Lien',
            targets: { default: 'https://exemple.fr/page', ios: null, android: null },
            utm: { source: '', medium: '', campaign: '', term: '', content: '' }
        }),
        password_hash: null,
        expires_at: null,
        max_visits: null,
        visits_total: 0,
        clicks_total: 0,
        enabled: 1,
        blocked_at: null,
        blocked_reason: null,
        check_enabled: 1,
        check_state: 'unknown',
        check_error: null,
        checked_at: null,
        check_due: null,
        created: 1,
        updated: 1,
        ...over
    };
}

export function memoryRepo(initial: LinkRow[] = []): MemoryRepo {
    const rows = [...initial];
    const daily = new Map<string, DailyDelta>();
    const dims = new Map<string, DimDelta>();
    const seen = new Set<string>();
    const usage = new Map<string, { visits: number; notified: number }>();
    const labelRows: MemoryRepo['labelRows'] = [];
    const reportRows: ReportRow[] = [];
    const find = (id: number) => rows.find((row) => row.id === id) ?? null;
    const unique = (candidate: LinkRow) => {
        for (const row of rows) {
            if (row.id === candidate.id) continue;
            if (row.code === candidate.code) throw duplicate('uniq_ft_shortlinks_code');
            if (candidate.domain_id !== null && row.domain_id === candidate.domain_id && row.slug === candidate.slug) {
                throw duplicate('uniq_ft_shortlinks_slug');
            }
        }
    };
    const inLinks = (ids: readonly number[]) => (row: { linkId: number }) => ids.includes(row.linkId);

    return {
        rows,
        daily,
        dims,
        seen,
        usage,
        labelRows,
        reportRows,
        links: {
            listVisible: async (ws) =>
                rows.filter((row) => row.workspace_id === ws).sort((a, b) => b.created - a.created),
            findVisible: async (id, ws) => rows.find((row) => row.id === id && row.workspace_id === ws) ?? null,
            findById: async (id) => find(id),
            findByCode: async (code) => rows.find((row) => row.code === code) ?? null,
            findBySlug: async (domainId, slug) =>
                rows.find((row) => row.domain_id === domainId && row.slug === slug) ?? null,
            countIn: async (ids) => rows.filter((row) => ids.includes(row.workspace_id)).length,
            totals: async () => ({
                visits: rows.reduce((sum, row) => sum + row.visits_total, 0),
                clicks: rows.reduce((sum, row) => sum + row.clicks_total, 0)
            }),
            listStock: async (ids) =>
                rows
                    .filter((row) => ids.includes(row.workspace_id))
                    .map((row) => ({ id: String(row.id), workspaceId: row.workspace_id })),
            async create(input) {
                const id = rows.reduce((max, row) => Math.max(max, row.id), 0) + 1;
                const row = linkRow({
                    id,
                    workspace_id: input.workspaceId,
                    user_id: input.userId,
                    code: input.code,
                    domain_id: input.domainId,
                    slug: input.slug,
                    content: input.content,
                    created: input.at,
                    updated: input.at
                });
                unique(row);
                rows.push(row);
                return id;
            },
            async update(id, ws, input) {
                const row = find(id);
                if (!row || row.workspace_id !== ws) return;
                unique({ ...row, domain_id: input.domainId, slug: input.slug });
                Object.assign(row, {
                    content: input.content,
                    domain_id: input.domainId,
                    slug: input.slug,
                    check_enabled: input.checkEnabled ? 1 : 0,
                    updated: input.at
                });
            },
            async updateContent(id, ws, content, at) {
                const row = find(id);
                if (row && row.workspace_id === ws) Object.assign(row, { content, updated: at });
            },
            async updateAccess(id, ws, input) {
                const row = find(id);
                if (!row || row.workspace_id !== ws) return;
                if (input.passwordHash !== undefined) row.password_hash = input.passwordHash;
                Object.assign(row, { expires_at: input.expiresAt, max_visits: input.maxVisits, updated: input.at });
            },
            async setEnabled(id, ws, enabled, at) {
                const row = find(id);
                if (row && row.workspace_id === ws) Object.assign(row, { enabled: enabled ? 1 : 0, updated: at });
            },
            async remove(id, ws) {
                const at = rows.findIndex((row) => row.id === id && row.workspace_id === ws);
                if (at === -1) return false;
                rows.splice(at, 1);
                return true;
            },
            async clearDomain(domainId, ws) {
                const touched = rows.filter((row) => row.domain_id === domainId && row.workspace_id === ws);
                for (const row of touched) Object.assign(row, { domain_id: null, slug: null });
                return touched.map((row) => row.id);
            },
            async domainUse(ws) {
                const out = new Map<number, number>();
                for (const row of rows) {
                    if (row.workspace_id === ws && row.domain_id !== null) {
                        out.set(row.domain_id, (out.get(row.domain_id) ?? 0) + 1);
                    }
                }
                return out;
            },
            async block(id, at, reason) {
                const row = find(id);
                if (row) Object.assign(row, { blocked_at: at, blocked_reason: reason });
            },
            async unblock(id) {
                const row = find(id);
                if (row) Object.assign(row, { blocked_at: null, blocked_reason: null });
            },
            async saveCheck(id, verdict) {
                const row = find(id);
                if (!row) return;
                row.check_due = verdict.due;
                if (verdict.state === undefined) return;
                Object.assign(row, { check_state: verdict.state, check_error: verdict.error, checked_at: verdict.at });
            },
            dueChecks: async (at, limit) =>
                rows
                    .filter(
                        (row) =>
                            row.check_enabled === 1 &&
                            row.enabled === 1 &&
                            row.blocked_at === null &&
                            (row.check_due === null || row.check_due <= at)
                    )
                    .slice(0, limit),
            async addTotals(id, clicks, visits) {
                const row = find(id);
                if (row)
                    Object.assign(row, {
                        clicks_total: row.clicks_total + clicks,
                        visits_total: row.visits_total + visits
                    });
            }
        },
        stats: {
            recent: async (ids, fromDay) =>
                [...daily.values()]
                    .filter((row) => ids.includes(row.linkId) && row.day >= fromDay)
                    .map((row) => ({ link_id: row.linkId, day: row.day, visits: row.visits })),
            async series(ids, fromDay, toDay) {
                const byDay = new Map<number, { day: number; clicks: number; visits: number; bots: number }>();
                for (const row of [...daily.values()].filter(inLinks(ids))) {
                    if (row.day < fromDay || row.day > toDay) continue;
                    const sum = byDay.get(row.day) ?? { day: row.day, clicks: 0, visits: 0, bots: 0 };
                    sum.clicks += row.clicks;
                    sum.visits += row.visits;
                    sum.bots += row.bots;
                    byDay.set(row.day, sum);
                }
                return [...byDay.values()];
            },
            async dims(ids, kind, fromDay, toDay, limit) {
                const sums = new Map<string, number>();
                for (const row of [...dims.values()].filter(inLinks(ids))) {
                    if (row.kind !== kind || row.day < fromDay || row.day > toDay) continue;
                    sums.set(row.value, (sums.get(row.value) ?? 0) + row.visits);
                }
                return [...sums]
                    .map(([value, visits]) => ({ value, visits }))
                    .sort((a, b) => b.visits - a.visits || a.value.localeCompare(b.value))
                    .slice(0, limit);
            },
            labels: async (ids) => labelRows.filter((row) => ids.includes(row.id)),
            visitsOn: async (ids, day) =>
                [...daily.values()]
                    .filter((row) => ids.includes(row.linkId) && row.day === day)
                    .reduce((sum, row) => sum + row.visits, 0)
        },
        counters: {
            async markSeen(day, linkId, ref) {
                const key = `${day}:${linkId}:${ref}`;
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            },
            async addDaily(list) {
                for (const delta of list) {
                    const key = `${delta.linkId}:${delta.day}`;
                    const row = daily.get(key) ?? {
                        linkId: delta.linkId,
                        day: delta.day,
                        clicks: 0,
                        visits: 0,
                        bots: 0
                    };
                    row.clicks += delta.clicks;
                    row.visits += delta.visits;
                    row.bots += delta.bots;
                    daily.set(key, row);
                }
            },
            async addDims(list) {
                for (const delta of list) {
                    const key = `${delta.linkId}:${delta.day}:${delta.kind}:${delta.value}`;
                    const row = dims.get(key) ?? { ...delta, visits: 0 };
                    row.visits += delta.visits;
                    dims.set(key, row);
                }
            },
            async addUsage(ws, month, visits) {
                const key = `${ws}:${month}`;
                const row = usage.get(key) ?? { visits: 0, notified: 0 };
                row.visits += visits;
                usage.set(key, row);
                return { ...row };
            },
            async setNotified(ws, month, level) {
                const row = usage.get(`${ws}:${month}`);
                if (row) row.notified = level;
            },
            monthlyVisits: async (ids, month) =>
                ids.reduce((sum, ws) => sum + (usage.get(`${ws}:${month}`)?.visits ?? 0), 0),
            async resolveLabel(ws, kind, ref, content) {
                const hit = labelRows.find(
                    (row) => row.workspace_id === ws && row.kind === kind && row.label_ref === ref
                );
                if (hit) return hit.id;
                const id = labelRows.length + 1;
                labelRows.push({ id, workspace_id: ws, kind, label_ref: ref, content });
                return id;
            },
            async purgeSeen(beforeDay) {
                for (const key of seen) if (Number(key.split(':')[0]) < beforeDay) seen.delete(key);
            },
            async purgeDims(beforeDay) {
                for (const [key, row] of dims) if (row.day < beforeDay) dims.delete(key);
            }
        },
        reports: {
            async insert(row) {
                reportRows.push({
                    id: reportRows.length + 1,
                    ref: row.ref,
                    link_id: row.linkId,
                    workspace_id: row.workspaceId,
                    reason: row.reason,
                    content: row.content,
                    status: 'open',
                    decision: '',
                    handled_by: null,
                    created: Math.floor(Date.now() / 1000),
                    closed_at: null,
                    link_blocked_at: null
                });
            },
            find: async (id) => {
                const row = reportRows.find((r) => r.id === id);
                return row
                    ? { ...row, link_blocked_at: row.link_id === null ? null : (find(row.link_id)?.blocked_at ?? null) }
                    : null;
            },
            list: async (status) =>
                reportRows.filter((r) => (status === 'open' ? r.status === 'open' : r.status !== 'open')),
            countOpen: async () => reportRows.filter((r) => r.status === 'open').length,
            countSince: async (since) => reportRows.filter((r) => r.created >= since).length,
            async close(id, status, decision, handledBy, at) {
                const row = reportRows.find((r) => r.id === id && r.status === 'open');
                if (row) Object.assign(row, { status, decision, handled_by: handledBy, closed_at: at });
            },
            async purge(before) {
                for (let i = reportRows.length - 1; i >= 0; i--) {
                    const row = reportRows[i];
                    if (row.status !== 'open' && row.closed_at !== null && row.closed_at < before)
                        reportRows.splice(i, 1);
                }
            }
        }
    };
}
