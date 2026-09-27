import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { z, ZodType } from 'zod';

import {
    projectAdd,
    projectArchive,
    projectAudienceLink,
    projectAudienceList,
    projectAudienceUnlink,
    projectBoard,
    projectCardAdd,
    projectCardArchive,
    projectCardMove,
    projectCardRestore,
    projectCardUpdate,
    projectCardSetMilestone,
    projectColumnAdd,
    projectColumnRemove,
    projectCommands,
    projectCount,
    projectDashboard,
    projectDashboardArrange,
    projectDashboardKpiRemove,
    projectDashboardKpiRun,
    projectDashboardKpiSave,
    projectDatabaseLink,
    projectDatabaseList,
    projectDatabaseUnlink,
    projectDepAdd,
    projectDeployLink,
    projectDeployList,
    projectDeployUnlink,
    projectEventList,
    projectGet,
    projectLinkCounts,
    projectList,
    projectMessageEdit,
    projectMessageList,
    projectMessageSend,
    projectMilestoneAdd,
    projectMilestoneSetReached,
    projectMyTasks,
    projectPlan,
    projectPublicationGet,
    projectPublicationRelink,
    projectPublish,
    projectReorder,
    projectRepoLink,
    projectRepoList,
    projectRepoUnlink,
    projectRestore,
    projectSetSecurityTier,
    projectSetStatus,
    projectSetVersion,
    projectUpdate,
    projectUptimeLink,
    projectUptimeList,
    projectUptimeUnlink
} from '../contracts/commands';
import { PROJECT_MAX_COLUMNS } from '../contracts/domain';
import type {
    DashboardTileRow,
    ProjectCardDepRow,
    ProjectCardRow,
    ProjectColumnRow,
    ProjectDraft,
    ProjectEventRow,
    ProjectMessageRow,
    ProjectMilestoneRow,
    ProjectRow
} from '../contracts/domain';
import {
    AUDIENCE_ITEMS_PROVIDER,
    DATABASE_ITEMS_PROVIDER,
    DATABASE_MEASURE_PROVIDER,
    DEPLOY_ITEMS_PROVIDER,
    GIT_ITEMS_PROVIDER,
    UPTIME_ITEMS_PROVIDER
} from '@deveye/types/sdk';
import { FeatureError, type SdkCipher, type SdkFeatureContext } from '@deveye/types/sdk/server';
import { createTestContext, testDomain, type TestContext, type TestContextOverrides } from '@deveye/types/sdk/testing';

import { projectsHandlers } from './handlers';
import { slugify, uniqueSlug } from './publication';
import { serverEntry } from './index';
import type { ProjectsRepo } from './repo';
import { memoryPublicationRepo, type MemoryPublicationRepo } from './testing/publicationRepo';

/**
 * Les handlers du module, sur le harnais du SDK. Ce qui mérite d'être tenu, c'est ce
 * qui ne lève nulle part quand ça se dérègle : les deux étages par projet et la
 * conversion qui re-chiffre tout l'arbre, le verrou (masquer plutôt que lever dans
 * les listes, `locked` sur un projet gardé, sauf quand aucun corps chiffré n'est
 * touché), les sujets battus par chaque écriture, les liaisons passées par les
 * contrats d'éléments, les gardes de forme (pas de carte qui change de projet, pas
 * de cycle, pas de colonne pleine retirée, un assigné ou une mention qui est un
 * membre), la frise posée par les mutations elles-mêmes, et le partage
 * inter-espaces (l'arbre se lit et s'écrit chez le domicile, la configuration s'y
 * refuse depuis une fenêtre).
 */

/** Le handler d'un contrat, typé par ce contrat (le registre est hétérogène). */
function handlerFor<C extends { command: string; input: ZodType; output: ZodType }>(contract: C) {
    const def = projectsHandlers.find((h) => h.command === contract.command);
    assert.ok(def, `handler ${contract.command} manquant`);
    return def.handler as (
        ctx: SdkFeatureContext<ProjectsRepo>,
        input: z.output<C['input']>
    ) => Promise<z.input<C['output']>>;
}

const failsWith =
    (code: FeatureError['code']) =>
    (e: unknown): boolean =>
        e instanceof FeatureError && e.code === code;

interface LinkRow {
    project_id: number;
    workspace_id: number;
    item_id: number;
}

interface ReadRow {
    card_id: number;
    user_id: number;
    workspace_id: number;
    last_read_message_id: number;
}

interface FakeRepo extends ProjectsRepo {
    publication: MemoryPublicationRepo;
    rows: {
        projects: ProjectRow[];
        columns: ProjectColumnRow[];
        cards: ProjectCardRow[];
        messages: ProjectMessageRow[];
        reads: ReadRow[];
        milestones: ProjectMilestoneRow[];
        deps: ProjectCardDepRow[];
        events: ProjectEventRow[];
        links: Record<'uptime' | 'database' | 'deploy' | 'repo' | 'site', LinkRow[]>;
        dashboard: DashboardTileRow[];
    };
}

/** Un corps de projet tel que le codec à l'identité le range (ou le lit). */
function body(title: string, version = ''): string {
    return JSON.stringify({ title, icon: '', description: '', tags: [], version });
}

function project(over: Partial<ProjectRow> & { id: number }): ProjectRow {
    return {
        workspace_id: 1,
        user_id: 1,
        status: 'active',
        security_tier: 'open',
        version_source: 'manual',
        show_overview: 1,
        show_timeline: 1,
        sort_order: over.id,
        start_date: null,
        due_date: null,
        archived_at: null,
        content: body(`Projet ${over.id}`),
        created: 1,
        updated: 1,
        ...over
    };
}

function column(over: Partial<ProjectColumnRow> & { id: number; project_id: number }): ProjectColumnRow {
    return {
        workspace_id: 1,
        sort_order: over.id,
        counts_as_done: 0,
        wip_limit: null,
        content: JSON.stringify({ name: `Colonne ${over.id}` }),
        created: 1,
        ...over
    };
}

function card(over: Partial<ProjectCardRow> & { id: number; project_id: number; column_id: number }): ProjectCardRow {
    return {
        workspace_id: 1,
        sort_order: over.id,
        author_user_id: 1,
        assignee_user_id: null,
        priority: 0,
        start_date: null,
        due_date: null,
        estimate_minutes: null,
        required_open_count: 0,
        milestone_id: null,
        archived_at: null,
        message_count: 0,
        last_message_at: null,
        content: JSON.stringify({ title: `Carte ${over.id}`, description: '', checklist: [] }),
        created: 1,
        updated: 1,
        ...over
    };
}

function message(
    over: Partial<ProjectMessageRow> & { id: number; card_id: number; project_id: number }
): ProjectMessageRow {
    return {
        workspace_id: 1,
        author_user_id: 1,
        mentions: null,
        created: over.id,
        edited: null,
        content: JSON.stringify({ text: `Message ${over.id}` }),
        ...over
    };
}

function event(over: Partial<ProjectEventRow> & { id: number; project_id: number }): ProjectEventRow {
    return {
        workspace_id: 1,
        actor_user_id: 1,
        kind: 'projects.status',
        ref_type: null,
        ref_id: null,
        created: over.id,
        content: JSON.stringify({ label: `Événement ${over.id}`, from: null, to: null }),
        ...over
    };
}

/**
 * Un dépôt en mémoire, même contrat que le vrai, sur des tableaux que les tests
 * lisent après coup. Les listes d'identifiants liés rendent l'ordre d'insertion, la
 * jointure d'ordre du vrai dépôt n'ayant rien à prouver ici.
 *
 * `projections` reproduit `item_shares` : `projectId → espaces où il est projeté`,
 * la seconde branche de `listVisible` / `findVisible`, que le harnais (`shares`)
 * doit dire en écho pour que `ctx.sharing.scope()` connaisse le domicile. Lu à
 * l'appel, un test qui mime `items.forget` le mute après coup.
 */
function fakeRepo(projections: Record<number, number[]> = {}): FakeRepo {
    let seq = 100;
    const rows: FakeRepo['rows'] = {
        projects: [],
        columns: [],
        cards: [],
        messages: [],
        reads: [],
        milestones: [],
        deps: [],
        events: [],
        links: { uptime: [], database: [], deploy: [], repo: [], site: [] },
        dashboard: []
    };
    // `locate` rend la ligne vivante, pour les mutations ; `find` en rend une copie,
    // comme une base rend une ligne fraîche : un handler qui relit une ligne après
    // l'avoir écrite ne doit pas voir sa lecture d'avant changer.
    const locate = <T extends { id: number; workspace_id: number }>(list: T[], id: number, ws: number): T | null =>
        list.find((r) => r.id === id && r.workspace_id === ws) ?? null;
    const find = <T extends { id: number; workspace_id: number }>(list: T[], id: number, ws: number): T | null => {
        const row = locate(list, id, ws);
        return row ? { ...row } : null;
    };
    // Par identifiant seul, comme les lectures d'une ligne de l'arbre dont le handler
    // remonte au projet avant d'agir.
    const findAny = <T extends { id: number }>(list: T[], id: number): T | null => {
        const row = list.find((r) => r.id === id);
        return row ? { ...row } : null;
    };
    const visible = (p: ProjectRow, ws: number) =>
        p.workspace_id === ws || (p.security_tier === 'open' && (projections[p.id] ?? []).includes(ws));
    const unreadOf = (c: ProjectCardRow, userId: number): number => {
        const mark = rows.reads.find((r) => r.card_id === c.id && r.user_id === userId)?.last_read_message_id ?? 0;
        return rows.messages.filter((m) => m.card_id === c.id && m.id > mark).length;
    };
    const ids = (kind: keyof FakeRepo['rows']['links']) => async (projectId: number, ws: number) =>
        rows.links[kind].filter((l) => l.project_id === projectId && l.workspace_id === ws).map((l) => l.item_id);
    const link = (kind: keyof FakeRepo['rows']['links']) => async (projectId: number, ws: number, itemId: number) => {
        if (!rows.links[kind].some((l) => l.project_id === projectId && l.item_id === itemId)) {
            rows.links[kind].push({ project_id: projectId, workspace_id: ws, item_id: itemId });
        }
    };
    const unlink = (kind: keyof FakeRepo['rows']['links']) => async (projectId: number, ws: number, itemId: number) => {
        const before = rows.links[kind].length;
        rows.links[kind] = rows.links[kind].filter(
            (l) => !(l.project_id === projectId && l.workspace_id === ws && l.item_id === itemId)
        );
        return rows.links[kind].length < before;
    };
    const unlinkAll = (kind: keyof FakeRepo['rows']['links']) => async (projectId: number, ws: number) => {
        const before = rows.links[kind].length;
        rows.links[kind] = rows.links[kind].filter((l) => !(l.project_id === projectId && l.workspace_id === ws));
        return before - rows.links[kind].length;
    };
    const detach = (kind: keyof FakeRepo['rows']['links']) => async (itemId: number, ws: number) => {
        const before = rows.links[kind].length;
        rows.links[kind] = rows.links[kind].filter((l) => !(l.item_id === itemId && l.workspace_id === ws));
        return before - rows.links[kind].length;
    };
    const usage = (kind: keyof FakeRepo['rows']['links'], archivedToo: boolean) => async (itemId: number, ws: number) =>
        rows.links[kind]
            .filter((l) => l.item_id === itemId && l.workspace_id === ws)
            .map((l) => rows.projects.find((p) => p.id === l.project_id))
            .filter(
                (p): p is ProjectRow =>
                    p !== undefined && p.security_tier === 'open' && (archivedToo || p.archived_at === null)
            )
            .map((p) => ({ project_id: p.id, status: p.status, content: p.content }));
    const counts = (kind: keyof FakeRepo['rows']['links']) => async (ws: number) => {
        const map = new Map<number, number>();
        for (const l of rows.links[kind]) {
            if (l.workspace_id === ws) map.set(l.item_id, (map.get(l.item_id) ?? 0) + 1);
        }
        return map;
    };
    const cells = [
        { table: 'project_columns', list: () => rows.columns },
        { table: 'project_cards', list: () => rows.cards },
        { table: 'project_messages', list: () => rows.messages },
        { table: 'project_milestones', list: () => rows.milestones },
        { table: 'project_events', list: () => rows.events },
        { table: 'ft_projects_dashboard_tiles', list: () => rows.dashboard }
    ];
    return {
        rows,
        projects: {
            listVisible: async (ws, archived) =>
                rows.projects
                    .filter((p) => visible(p, ws) && (p.archived_at !== null) === archived)
                    .sort((a, b) =>
                        archived
                            ? (b.archived_at ?? 0) - (a.archived_at ?? 0) || a.id - b.id
                            : Number(a.workspace_id !== ws) - Number(b.workspace_id !== ws) ||
                              a.sort_order - b.sort_order ||
                              a.id - b.id
                    ),
            findById: async (id, ws) => find(rows.projects, id, ws),
            findVisible: async (id, ws) => {
                const row = rows.projects.find((p) => p.id === id && visible(p, ws));
                return row ? { ...row } : null;
            },
            async create(input) {
                const row = project({
                    id: ++seq,
                    workspace_id: input.workspaceId,
                    user_id: input.userId,
                    status: input.status,
                    show_overview: input.showOverview ? 1 : 0,
                    show_timeline: input.showTimeline ? 1 : 0,
                    security_tier: input.securityTier,
                    start_date: input.startDate,
                    due_date: input.dueDate,
                    content: input.content,
                    sort_order: rows.projects.length
                });
                rows.projects.push(row);
                return row;
            },
            async update(id, ws, input) {
                const row = locate(rows.projects, id, ws);
                if (!row) return null;
                Object.assign(row, {
                    status: input.status,
                    show_overview: input.showOverview ? 1 : 0,
                    show_timeline: input.showTimeline ? 1 : 0,
                    start_date: input.startDate,
                    due_date: input.dueDate,
                    content: input.content,
                    updated: row.updated + 1
                });
                return row;
            },
            async setStatus(id, ws, status) {
                const row = locate(rows.projects, id, ws);
                if (row) row.status = status;
                return row;
            },
            async setVersionSource(id, ws, source) {
                const row = locate(rows.projects, id, ws);
                if (row) row.version_source = source;
                return row;
            },
            async setSecurityTier(id, ws, tier, content) {
                const row = locate(rows.projects, id, ws);
                if (row) Object.assign(row, { security_tier: tier, content });
                return row;
            },
            async archive(id, ws, at) {
                const row = locate(rows.projects, id, ws);
                if (row) row.archived_at = at;
                return row !== null;
            },
            async restore(id, ws) {
                const row = locate(rows.projects, id, ws);
                if (row) row.archived_at = null;
                return row !== null;
            },
            async reorder(ws, projectIds) {
                projectIds.forEach((id, i) => {
                    const row = locate(rows.projects, id, ws);
                    if (row) row.sort_order = i;
                });
            },
            statsFor: async (projectIds, userId, now) =>
                rows.projects
                    .filter((p) => projectIds.includes(p.id) && p.archived_at === null)
                    .map((p) => {
                        const live = rows.cards.filter((c) => c.project_id === p.id && c.archived_at === null);
                        const isDone = (c: ProjectCardRow) =>
                            rows.columns.find((col) => col.id === c.column_id)?.counts_as_done === 1;
                        const open = live.filter((c) => !isDone(c));
                        const upcoming = open.filter((c) => c.due_date !== null && c.due_date >= now);
                        return {
                            project_id: p.id,
                            card_total: live.length,
                            card_done: live.length - open.length,
                            card_overdue: open.filter((c) => c.due_date !== null && c.due_date < now).length,
                            next_due_date: upcoming.length
                                ? Math.min(...upcoming.map((c) => c.due_date as number))
                                : null,
                            unread: live.reduce((sum, c) => sum + unreadOf(c, userId), 0)
                        };
                    })
        },
        board: {
            listColumns: async (projectId, ws) =>
                rows.columns
                    .filter((c) => c.project_id === projectId && c.workspace_id === ws)
                    .sort((a, b) => a.sort_order - b.sort_order || a.id - b.id),
            findColumn: async (id) => findAny(rows.columns, id),
            archiveColumnCards: async (columnId, ws, at) => {
                const hit = rows.cards.filter(
                    (c) => c.column_id === columnId && c.workspace_id === ws && c.archived_at === null
                );
                for (const c of hit) c.archived_at = at;
                return hit.length;
            },
            async createColumn(input) {
                const row = column({
                    id: ++seq,
                    project_id: input.projectId,
                    workspace_id: input.workspaceId,
                    sort_order: rows.columns.filter((c) => c.project_id === input.projectId).length,
                    counts_as_done: input.countsAsDone ? 1 : 0,
                    wip_limit: input.wipLimit ?? null,
                    content: input.content
                });
                rows.columns.push(row);
                return row;
            },
            async updateColumn(id, ws, input) {
                const row = locate(rows.columns, id, ws);
                if (!row) return null;
                Object.assign(row, {
                    content: input.content,
                    counts_as_done: input.countsAsDone ? 1 : 0,
                    wip_limit: input.wipLimit
                });
                return row;
            },
            countLiveCardsInColumn: async (id, ws) =>
                rows.cards.filter((c) => c.column_id === id && c.workspace_id === ws && c.archived_at === null).length,
            async deleteColumn(id, ws) {
                const before = rows.columns.length;
                rows.columns = rows.columns.filter((c) => !(c.id === id && c.workspace_id === ws));
                if (rows.columns.length === before) return false;
                // Ce que fait la contrainte `ON DELETE SET NULL` en base.
                for (const card of rows.cards) if (card.column_id === id) card.column_id = null;
                return true;
            },
            async reorderColumns(projectId, ws, columnIds) {
                columnIds.forEach((id, i) => {
                    const row = locate(rows.columns, id, ws);
                    if (row && row.project_id === projectId) row.sort_order = i;
                });
            },
            listCards: async (projectId, ws, archived) =>
                rows.cards
                    .filter(
                        (c) =>
                            c.project_id === projectId && c.workspace_id === ws && (c.archived_at !== null) === archived
                    )
                    .sort((a, b) => a.sort_order - b.sort_order || a.id - b.id),
            findCard: async (id) => findAny(rows.cards, id),
            async createCard(input) {
                const row = card({
                    id: ++seq,
                    project_id: input.projectId,
                    workspace_id: input.workspaceId,
                    column_id: input.columnId,
                    sort_order: rows.cards.filter((c) => c.column_id === input.columnId).length,
                    author_user_id: input.authorUserId,
                    assignee_user_id: input.assigneeUserId,
                    priority: input.priority,
                    start_date: input.startDate,
                    due_date: input.dueDate,
                    estimate_minutes: input.estimateMinutes,
                    required_open_count: input.requiredOpen,
                    content: input.content
                });
                rows.cards.push(row);
                return row;
            },
            async updateCard(id, ws, input) {
                const row = locate(rows.cards, id, ws);
                if (!row) return null;
                Object.assign(row, {
                    assignee_user_id: input.assigneeUserId,
                    priority: input.priority,
                    start_date: input.startDate,
                    due_date: input.dueDate,
                    estimate_minutes: input.estimateMinutes,
                    required_open_count: input.requiredOpen,
                    content: input.content,
                    updated: row.updated + 1
                });
                return row;
            },
            async moveCards(ws, columnId, cardIds) {
                cardIds.forEach((id, i) => {
                    const row = locate(rows.cards, id, ws);
                    if (row) Object.assign(row, { column_id: columnId, sort_order: i });
                });
            },
            async archiveCard(id, ws, at) {
                const row = locate(rows.cards, id, ws);
                if (row) row.archived_at = at;
                return row !== null;
            },
            async restoreCard(id, ws, columnId) {
                const row = locate(rows.cards, id, ws);
                if (row) {
                    row.archived_at = null;
                    row.column_id = columnId;
                }
                return row !== null;
            },
            unreadByProject: async (projectId, ws, userId) =>
                rows.cards
                    .filter((c) => c.project_id === projectId && c.workspace_id === ws && c.archived_at === null)
                    .map((c) => ({ card_id: c.id, unread: unreadOf(c, userId) })),
            listAssignedIn: async (projectIds, userId) =>
                rows.cards.filter(
                    (c) => projectIds.includes(c.project_id) && c.assignee_user_id === userId && c.archived_at === null
                )
        },
        chat: {
            listByCard: async (cardId, ws, before, limit) =>
                rows.messages
                    .filter((m) => m.card_id === cardId && m.workspace_id === ws && (before === null || m.id < before))
                    .sort((a, b) => b.id - a.id)
                    .slice(0, limit),
            findById: async (id) => findAny(rows.messages, id),
            async create(input) {
                const row = message({
                    id: ++seq,
                    card_id: input.cardId,
                    project_id: input.projectId,
                    workspace_id: input.workspaceId,
                    author_user_id: input.authorUserId,
                    mentions: input.mentions.length ? JSON.stringify(input.mentions) : null,
                    content: input.content
                });
                rows.messages.push(row);
                const c = locate(rows.cards, input.cardId, input.workspaceId);
                if (c) c.message_count += 1;
                return row;
            },
            async update(id, ws, input) {
                const row = locate(rows.messages, id, ws);
                if (!row) return null;
                Object.assign(row, {
                    content: input.content,
                    mentions: input.mentions.length ? JSON.stringify(input.mentions) : null,
                    edited: 2
                });
                return row;
            },
            async markRead(cardId, ws, userId, lastMessageId) {
                const mark = rows.reads.find((r) => r.card_id === cardId && r.user_id === userId);
                if (mark) mark.last_read_message_id = Math.max(mark.last_read_message_id, lastMessageId);
                else
                    rows.reads.push({
                        card_id: cardId,
                        user_id: userId,
                        workspace_id: ws,
                        last_read_message_id: lastMessageId
                    });
            }
        },
        plan: {
            listMilestones: async (projectId, ws) =>
                rows.milestones
                    .filter((m) => m.project_id === projectId && m.workspace_id === ws)
                    .sort((a, b) => a.due_date - b.due_date || a.id - b.id),
            findMilestone: async (id) => findAny(rows.milestones, id),
            milestoneDateTaken: async ({ projectId, workspaceId, dueDate, exceptId }) =>
                rows.milestones.some(
                    (m) =>
                        m.project_id === projectId &&
                        m.workspace_id === workspaceId &&
                        m.due_date === dueDate &&
                        m.id !== exceptId
                ),
            async createMilestone(input) {
                const row: ProjectMilestoneRow = {
                    id: ++seq,
                    project_id: input.projectId,
                    workspace_id: input.workspaceId,
                    due_date: input.dueDate,
                    reached_at: null,
                    sort_order: rows.milestones.length,
                    content: input.content,
                    created: 1
                };
                rows.milestones.push(row);
                return row;
            },
            async updateMilestone(id, ws, input) {
                const row = locate(rows.milestones, id, ws);
                if (row) Object.assign(row, { due_date: input.dueDate, content: input.content });
                return row;
            },
            async setMilestoneReached(id, ws, reachedAt) {
                const row = locate(rows.milestones, id, ws);
                if (row) row.reached_at = reachedAt;
                return row;
            },
            async deleteMilestone(id, ws) {
                const before = rows.milestones.length;
                rows.milestones = rows.milestones.filter((m) => !(m.id === id && m.workspace_id === ws));
                return rows.milestones.length < before;
            },
            async setCardMilestone(cardId, ws, milestoneId) {
                const row = locate(rows.cards, cardId, ws);
                if (row) row.milestone_id = milestoneId;
                return row !== null;
            },
            listDeps: async (projectId) => rows.deps.filter((d) => d.project_id === projectId),
            async addDep(cardId, blockedByCardId, projectId) {
                if (!rows.deps.some((d) => d.card_id === cardId && d.blocked_by_card_id === blockedByCardId)) {
                    rows.deps.push({
                        card_id: cardId,
                        blocked_by_card_id: blockedByCardId,
                        project_id: projectId,
                        created: 1
                    });
                }
            },
            async removeDep(cardId, blockedByCardId) {
                const before = rows.deps.length;
                rows.deps = rows.deps.filter(
                    (d) => !(d.card_id === cardId && d.blocked_by_card_id === blockedByCardId)
                );
                return rows.deps.length < before;
            }
        },
        history: {
            listByProject: async (projectId, ws, before, limit) =>
                rows.events
                    .filter(
                        (e) => e.project_id === projectId && e.workspace_id === ws && (before === null || e.id < before)
                    )
                    .sort((a, b) => b.id - a.id)
                    .slice(0, limit),
            async record(input) {
                rows.events.push(
                    event({
                        id: ++seq,
                        project_id: input.projectId,
                        workspace_id: input.workspaceId,
                        actor_user_id: input.actorUserId,
                        kind: input.kind,
                        ref_type: input.refType,
                        ref_id: input.refId,
                        content: input.content
                    })
                );
            }
        },
        links: {
            listServiceIds: ids('uptime'),
            link: link('uptime'),
            unlink: unlink('uptime'),
            listByProject: async (projectId, ws) =>
                rows.links.uptime
                    .filter((l) => l.project_id === projectId && l.workspace_id === ws)
                    .map((l) => ({
                        project_id: l.project_id,
                        service_id: l.item_id,
                        workspace_id: l.workspace_id,
                        created: 1
                    })),
            listServiceUsage: usage('uptime', true),
            countServiceLinks: counts('uptime'),
            detachService: detach('uptime'),
            listDatabaseIds: ids('database'),
            linkDatabase: link('database'),
            unlinkDatabase: unlink('database'),
            unlinkAllDatabases: async (projectId, ws) => {
                await unlinkAll('database')(projectId, ws);
            },
            listDatabaseUsage: usage('database', true),
            countDatabaseLinks: counts('database'),
            detachDatabase: detach('database'),
            listDeployTargetIds: ids('deploy'),
            linkDeployTarget: link('deploy'),
            unlinkDeployTarget: unlink('deploy'),
            unlinkAllDeployTargets: unlinkAll('deploy'),
            listDeployUsage: usage('deploy', true),
            countDeployLinks: counts('deploy'),
            detachDeployTarget: detach('deploy'),
            listRepoIds: ids('repo'),
            linkRepo: link('repo'),
            unlinkRepo: unlink('repo'),
            unlinkAllRepos: unlinkAll('repo'),
            listRepoUsage: usage('repo', true),
            countRepoLinks: counts('repo'),
            detachRepo: detach('repo'),
            listSiteIds: ids('site'),
            linkSite: link('site'),
            unlinkSite: unlink('site'),
            unlinkAllSites: async (projectId, ws) => {
                await unlinkAll('site')(projectId, ws);
            },
            listSiteUsage: usage('site', false),
            countSiteLinks: counts('site'),
            detachSite: detach('site')
        },
        dashboard: {
            list: async (projectId, ws) =>
                rows.dashboard
                    .filter((t) => t.project_id === projectId && t.workspace_id === ws)
                    .sort((a, b) => a.sort_order - b.sort_order || a.id - b.id)
                    .map((t) => ({ ...t })),
            async arrange(projectId, ws, tiles) {
                for (const [index, tile] of tiles.entries()) {
                    const found = rows.dashboard.find(
                        (t) => t.project_id === projectId && t.workspace_id === ws && t.tile_key === tile.key
                    );
                    if (found) {
                        found.sort_order = index;
                        found.hidden = tile.hidden ? 1 : 0;
                        continue;
                    }
                    rows.dashboard.push({
                        id: rows.dashboard.length + 1,
                        project_id: projectId,
                        workspace_id: ws,
                        tile_key: tile.key,
                        sort_order: index,
                        hidden: tile.hidden ? 1 : 0,
                        database_id: null,
                        content: '',
                        last_number: null,
                        last_error: null,
                        last_check_at: null,
                        created: 1
                    });
                }
                const kept = new Set(tiles.map((t) => t.key));
                rows.dashboard = rows.dashboard.filter(
                    (t) =>
                        !(
                            t.project_id === projectId &&
                            t.workspace_id === ws &&
                            t.content === '' &&
                            !kept.has(t.tile_key)
                        )
                );
            },
            async upsertKpi({ projectId, workspaceId, tileKey, databaseId, content }) {
                const found = rows.dashboard.find((t) => t.project_id === projectId && t.tile_key === tileKey);
                if (found) {
                    found.database_id = databaseId;
                    found.content = content;
                    return { ...found };
                }
                const row: DashboardTileRow = {
                    id: rows.dashboard.length + 1,
                    project_id: projectId,
                    workspace_id: workspaceId,
                    tile_key: tileKey,
                    sort_order: 0,
                    hidden: 0,
                    database_id: databaseId,
                    content,
                    last_number: null,
                    last_error: null,
                    last_check_at: null,
                    created: 1
                };
                rows.dashboard.push(row);
                return { ...row };
            },
            async removeKpi(projectId, ws, tileKey) {
                const before = rows.dashboard.length;
                rows.dashboard = rows.dashboard.filter(
                    (t) =>
                        !(
                            t.project_id === projectId &&
                            t.workspace_id === ws &&
                            t.tile_key === tileKey &&
                            t.content !== ''
                        )
                );
                return rows.dashboard.length < before;
            },
            async recordMeasure(projectId, tileKey, outcome) {
                const found = rows.dashboard.find((t) => t.project_id === projectId && t.tile_key === tileKey);
                if (!found) return;
                if (outcome.value !== null) found.last_number = outcome.value;
                found.last_error = outcome.error;
                found.last_check_at = outcome.at;
            }
        },
        rekey: {
            readTree: async (projectId, ws) =>
                cells.flatMap(({ table, list }) =>
                    list()
                        .filter((r) => r.project_id === projectId && r.workspace_id === ws && r.content !== '')
                        .map((r) => ({ table, column: 'content', id: r.id, value: r.content }))
                ),
            async write(projectId, cell) {
                const list = cells.find((c) => c.table === cell.table)?.list() ?? [];
                const row = list.find((r) => r.id === cell.id && r.project_id === projectId);
                if (row) row.content = cell.value;
            }
        },
        publication: memoryPublicationRepo(() => rows.projects)
    };
}

/**
 * Un codec qui étiquette son étage : le harnais chiffre à l'identité, ce qui ne dit
 * pas sous quel codec une ligne a été écrite. Posé sur `ctx.cipher`, il rend visible
 * le choix du palier, qui est toute la question ici.
 */
function taggedCipher(tag: string): SdkCipher {
    return {
        encrypt: async (plain) => `${tag}:${plain}`,
        decrypt: async (blob) => blob.slice(tag.length + 1),
        tryDecrypt: async (blob) => (blob.startsWith(`${tag}:`) ? blob.slice(tag.length + 1) : null)
    };
}

function tagging(ctx: TestContext<FakeRepo>): TestContext<FakeRepo> {
    ctx.cipher = (mode) => taggedCipher(mode ?? 'server');
    return ctx;
}

/**
 * Le même étiquetage vu d'une fenêtre : l'étage ouvert d'ici porte `server:`, celui
 * d'un projet projeté l'étiquette de son domicile. C'est ce qui prouve qu'une ligne
 * écrite depuis la fenêtre l'est sous la clé de l'espace d'origine, et lue avec
 * elle ; à l'identité, le harnais ne distinguerait pas les deux.
 */
function windowTagging(ctx: TestContext<FakeRepo>, homeTag = 'home'): TestContext<FakeRepo> {
    tagging(ctx);
    const scope = ctx.sharing.scope;
    ctx.sharing = {
        ...ctx.sharing,
        scope: async () => {
            const real = await scope();
            return {
                ...real,
                cipherFor: async (itemId) => taggedCipher(real.homeOf(itemId) === null ? 'server' : homeTag)
            };
        }
    };
    return ctx;
}

/** Chez lui : l'étage ouvert de l'espace d'origine porte `home:`. */
function homeTagging(ctx: TestContext<FakeRepo>): TestContext<FakeRepo> {
    ctx.cipher = (mode) => taggedCipher(mode === 'private' ? 'private' : 'home');
    return ctx;
}

function contextWith(repo: FakeRepo, over: Omit<TestContextOverrides<FakeRepo>, 'repo'> = {}): TestContext<FakeRepo> {
    return createTestContext({ repo, ...over });
}

/** Deux membres (1 et 2) dans l'espace, là où le harnais n'en liste qu'un. */
const TWO_MEMBERS = {
    members: {
        list: async () => [
            { userId: 1, name: 'Moi', isOwner: true, color: null },
            { userId: 2, name: 'Toi', isOwner: false, color: null }
        ]
    }
};

const DRAFT: ProjectDraft = {
    title: 'Nouveau',
    icon: '',
    description: '',
    tags: [],
    status: 'active',
    showOverview: true,
    showTimeline: true,
    timelineZoom: 'week',
    startDate: null,
    dueDate: null
};

/** Un projet ouvert (1) et un projet gardé (2), chacun avec une colonne et une carte. */
function seedTwoTiers(repo: FakeRepo): void {
    repo.rows.projects.push(project({ id: 1 }), project({ id: 2, security_tier: 'guarded', content: body('Secret') }));
    repo.rows.columns.push(column({ id: 10, project_id: 1 }), column({ id: 20, project_id: 2 }));
    repo.rows.cards.push(
        card({ id: 11, project_id: 1, column_id: 10 }),
        card({ id: 21, project_id: 2, column_id: 20 })
    );
}

describe('le registre des commandes', () => {
    it('porte exactement les commandes du contrat, sous le préfixe du module', () => {
        assert.deepEqual(projectsHandlers.map((h) => h.command).sort(), projectCommands.map((c) => c.command).sort());
        assert.ok(projectsHandlers.every((h) => h.command.startsWith('projects.')));
    });

    it('déclare `mutates` sur chaque écriture, le filet de démarrage ne voyant aucun de ces noms', () => {
        const reads = new Set([
            'projects.list',
            'projects.count',
            'projects.get',
            'projects.board',
            'projects.messageList',
            // Une lecture est personnelle : la diffuser ferait re-solliciter tout
            // l'espace parce qu'une personne a ouvert une carte.
            'projects.markRead',
            'projects.plan',
            'projects.eventList',
            'projects.repoList',
            'projects.deployList',
            'projects.myTasks',
            'projects.linkCounts',
            'projects.uptimeList',
            'projects.databaseList',
            'projects.audienceList',
            'projects.dashboard',
            'projects.publication'
        ]);
        // Elles ne persistent rien, mais sollicitent un service extérieur au nom
        // du projet : réservées à qui peut l'écrire, sans rien battre.
        const gestures = new Set(['projects.dashboardKpiTest']);
        for (const h of projectsHandlers) {
            if (reads.has(h.command)) {
                assert.equal(h.mutates, undefined, `${h.command} lit, et ne doit rien battre`);
                assert.equal(h.access?.level, undefined, `${h.command} lit, au niveau par défaut`);
                // Une lecture peut tout de même demander une permission propre :
                // l'histoire d'un projet ne se donne pas avec le projet.
                assert.deepEqual(
                    h.access?.extras,
                    h.command === 'projects.eventList' ? ['history'] : undefined,
                    `${h.command} et ses permissions propres`
                );
            } else if (gestures.has(h.command)) {
                assert.equal(h.mutates, undefined, `${h.command} ne persiste rien, et ne doit rien battre`);
                assert.equal(h.access?.level, 'write', `${h.command} est un geste, sous le droit write`);
            } else {
                assert.ok(h.mutates, `${h.command} écrit sans déclarer mutates`);
                assert.equal(h.access?.level, 'write', `${h.command} écrit sous le droit write`);
            }
        }
    });

    it('la discussion bat `projectsChat` et jamais `projects` ; une liaison bat aussi la feature visée', () => {
        const topicsOf = (command: string) => projectsHandlers.find((h) => h.command === command)?.mutates;
        assert.deepEqual(topicsOf('projects.messageSend'), ['projectsChat']);
        assert.deepEqual(topicsOf('projects.messageEdit'), ['projectsChat']);
        assert.deepEqual(topicsOf('projects.repoLink'), ['projects', 'git']);
        assert.deepEqual(topicsOf('projects.repoUnlink'), ['projects', 'git']);
        assert.deepEqual(topicsOf('projects.deployLink'), ['projects', 'deploy']);
        assert.deepEqual(topicsOf('projects.databaseUnlink'), ['projects', 'database']);
        assert.deepEqual(topicsOf('projects.audienceLink'), ['projects', 'audience']);
        assert.deepEqual(topicsOf('projects.uptimeLink'), ['projects', 'uptime']);
        assert.deepEqual(topicsOf('projects.uptimeUnlink'), ['projects', 'uptime']);
        assert.equal(topicsOf('projects.cardAdd'), true);
        // Aucune liste ne nomme un sujet que le boot refuserait : les nôtres et ceux
        // des cinq features reliées.
        const known = new Set(['projects', 'projectsChat', 'git', 'deploy', 'database', 'audience', 'uptime']);
        for (const h of projectsHandlers) {
            if (Array.isArray(h.mutates)) {
                for (const topic of h.mutates)
                    assert.ok(known.has(topic), `${h.command} bat un sujet inconnu : ${topic}`);
            }
        }
    });
});

describe('projects.list / projects.count : le portefeuille', () => {
    it('masque un projet gardé quand la session est scellée, compteurs compris, sans lever', async () => {
        const repo = fakeRepo();
        seedTwoTiers(repo);
        repo.rows.messages.push(message({ id: 30, card_id: 21, project_id: 2 }));
        const listed = await handlerFor(projectList)(contextWith(repo, { unlocked: false }), {});
        assert.deepEqual(
            listed.projects.map((p) => [p.project.id, p.project.title, p.masked, p.cardTotal, p.unread]),
            [
                [1, 'Projet 1', false, 1, 0],
                [2, '', true, 1, 1]
            ]
        );
        assert.deepEqual(await handlerFor(projectCount)(contextWith(repo), {}), { count: 2 });
    });

    it('révèle le projet gardé quand la session est déverrouillée', async () => {
        const repo = fakeRepo();
        seedTwoTiers(repo);
        const listed = await handlerFor(projectList)(contextWith(repo), {});
        assert.deepEqual(
            listed.projects.map((p) => [p.project.title, p.masked]),
            [
                ['Projet 1', false],
                ['Secret', false]
            ]
        );
    });

    it('ne liste que l’espace de l’appelant, et les archivés à part', async () => {
        const repo = fakeRepo();
        repo.rows.projects.push(
            project({ id: 1 }),
            project({ id: 2, workspace_id: 7 }),
            project({ id: 3, archived_at: 5 })
        );
        const active = await handlerFor(projectList)(contextWith(repo), {});
        assert.deepEqual(
            active.projects.map((p) => p.project.id),
            [1]
        );
        const archived = await handlerFor(projectList)(contextWith(repo), { archived: true });
        assert.deepEqual(
            archived.projects.map((p) => [p.project.id, p.project.archived]),
            [[3, true]]
        );
        assert.deepEqual(await handlerFor(projectCount)(contextWith(repo, { workspaceId: 7 }), {}), { count: 1 });
    });
});

describe('projects.get : le détail', () => {
    it('répond `locked` sur un projet gardé à une session scellée, et le lit déverrouillée', async () => {
        const repo = fakeRepo();
        seedTwoTiers(repo);
        await assert.rejects(
            handlerFor(projectGet)(contextWith(repo, { unlocked: false }), { projectId: 2 }),
            failsWith('locked')
        );
        const got = await handlerFor(projectGet)(contextWith(repo), { projectId: 2 });
        assert.equal(got.project.title, 'Secret');
        assert.equal(got.project.securityTier, 'guarded');
    });

    it('ne trouve pas un projet d’un autre espace', async () => {
        const repo = fakeRepo();
        repo.rows.projects.push(project({ id: 1, workspace_id: 7 }));
        await assert.rejects(handlerFor(projectGet)(contextWith(repo), { projectId: 1 }), failsWith('not_found'));
    });
});

describe('projects.add : les deux étages', () => {
    it('un projet gardé est refusé dans un espace partagé, sans rien écrire', async () => {
        const repo = fakeRepo();
        await assert.rejects(
            handlerFor(projectAdd)(contextWith(repo, { kind: 'shared' }), { project: DRAFT, securityTier: 'guarded' }),
            failsWith('validation')
        );
        assert.equal(repo.rows.projects.length, 0);
    });

    it('un projet ouvert naît sous le codec ouvert avec ses trois colonnes, sa première ligne de frise et son audit', async () => {
        const repo = fakeRepo();
        const ctx = tagging(contextWith(repo, { kind: 'shared' }));
        const added = await handlerFor(projectAdd)(ctx, { project: DRAFT, securityTier: 'open' });
        assert.equal(added.project.title, 'Nouveau');
        assert.ok(repo.rows.projects[0].content.startsWith('server:'));
        assert.deepEqual(
            repo.rows.columns.map((c) => [c.project_id, c.counts_as_done, c.content.startsWith('server:')]),
            [
                [added.project.id, 0, true],
                [added.project.id, 0, true],
                [added.project.id, 1, true]
            ]
        );
        assert.deepEqual(
            repo.rows.events.map((e) => e.kind),
            ['projects.created']
        );
        assert.equal(ctx.recorded.audits[0]?.action, 'projects.create');
    });

    it('un projet gardé s’écrit sous le codec gardé dans un espace personnel, colonnes et frise comprises', async () => {
        const repo = fakeRepo();
        const ctx = tagging(contextWith(repo, { kind: 'personal' }));
        const added = await handlerFor(projectAdd)(ctx, { project: DRAFT, securityTier: 'guarded' });
        assert.equal(added.project.securityTier, 'guarded');
        assert.ok(repo.rows.projects[0].content.startsWith('private:'));
        assert.ok(repo.rows.columns.every((c) => c.content.startsWith('private:')));
        assert.ok(repo.rows.events[0].content.startsWith('private:'));
    });
});

describe('projects.update / setStatus / setVersion : le profil', () => {
    it('refuse `locked` d’écrire un projet gardé à une session scellée, sans rien toucher', async () => {
        const repo = fakeRepo();
        seedTwoTiers(repo);
        const ctx = contextWith(repo, { unlocked: false });
        await assert.rejects(
            handlerFor(projectUpdate)(ctx, { projectId: 2, project: { ...DRAFT, title: 'Renommé' } }),
            failsWith('locked')
        );
        await assert.rejects(handlerFor(projectArchive)(ctx, { projectId: 2 }), failsWith('locked'));
        assert.equal(repo.rows.projects[1].content, body('Secret'));
        assert.equal(repo.rows.projects[1].archived_at, null);
    });

    it('un renommage et un changement de statut entrent dans la frise, une retouche de description non', async () => {
        const repo = fakeRepo();
        repo.rows.projects.push(project({ id: 1, content: body('Projet 1', '0.9.0') }));
        const ctx = contextWith(repo);
        await handlerFor(projectUpdate)(ctx, {
            projectId: 1,
            project: { ...DRAFT, title: 'Projet 1', description: 'd' }
        });
        assert.equal(repo.rows.events.length, 0);
        const updated = await handlerFor(projectUpdate)(ctx, {
            projectId: 1,
            project: { ...DRAFT, title: 'Projet un', status: 'paused' }
        });
        // La version n'est pas dans le brouillon : celle en place survit.
        assert.equal(updated.project.version, '0.9.0');
        assert.deepEqual(
            repo.rows.events.map((e) => [e.kind, JSON.parse(e.content)]),
            [
                ['projects.renamed', { label: 'Projet renommé', from: 'Projet 1', to: 'Projet un' }],
                ['projects.status', { label: 'Statut modifié', from: 'active', to: 'paused' }]
            ]
        );
    });

    it('une version manuelle se pose avec sa ligne de frise ; suivre les releases est refusé à un projet gardé', async () => {
        const repo = fakeRepo();
        seedTwoTiers(repo);
        const ctx = contextWith(repo);
        const set = await handlerFor(projectSetVersion)(ctx, { projectId: 1, source: 'manual', version: '1.2.0' });
        assert.equal(set.project.version, '1.2.0');
        assert.equal(set.project.versionSource, 'manual');
        assert.deepEqual(JSON.parse(repo.rows.events[0].content), {
            label: 'Version modifiée',
            from: null,
            to: '1.2.0'
        });
        await assert.rejects(
            handlerFor(projectSetVersion)(ctx, { projectId: 2, source: 'github_release', version: '' }),
            failsWith('validation')
        );
        // En `github_release`, le numéro appartient au module Git : celui demandé est
        // ignoré, celui en place est gardé.
        const followed = await handlerFor(projectSetVersion)(ctx, {
            projectId: 1,
            source: 'github_release',
            version: '9.9.9'
        });
        assert.equal(followed.project.version, '1.2.0');
        assert.equal(followed.project.versionSource, 'github_release');
    });
});

describe('projects.setSecurityTier : la conversion d’étage', () => {
    /** Un projet ouvert relié partout, tout son arbre sous le codec ouvert étiqueté. */
    function seedLinked(repo: FakeRepo): void {
        repo.rows.projects.push(
            project({ id: 1, version_source: 'github_release', content: `server:${body('Projet 1', '2.0')}` })
        );
        repo.rows.columns.push(column({ id: 10, project_id: 1, content: 'server:{"name":"À faire"}' }));
        repo.rows.cards.push(
            card({
                id: 11,
                project_id: 1,
                column_id: 10,
                content: 'server:{"title":"T","description":"","checklist":[]}'
            })
        );
        repo.rows.messages.push(message({ id: 12, card_id: 11, project_id: 1, content: 'server:{"text":"m"}' }));
        repo.rows.milestones.push({
            id: 13,
            project_id: 1,
            workspace_id: 1,
            due_date: 10,
            reached_at: null,
            sort_order: 0,
            content: 'server:{"name":"J","description":""}',
            created: 1
        });
        repo.rows.events.push(event({ id: 14, project_id: 1, content: 'server:{"label":"e","from":null,"to":null}' }));
        repo.rows.links.repo.push({ project_id: 1, workspace_id: 1, item_id: 5 });
        repo.rows.links.database.push({ project_id: 1, workspace_id: 1, item_id: 6 });
        repo.rows.links.site.push({ project_id: 1, workspace_id: 1, item_id: 7 });
        repo.rows.links.deploy.push({ project_id: 1, workspace_id: 1, item_id: 8 });
        repo.rows.links.uptime.push({ project_id: 1, workspace_id: 1, item_id: 9 });
    }

    it('passer en confidentiel re-chiffre tout l’arbre, retire les liaisons d’espace et coupe le suivi des releases', async () => {
        const repo = fakeRepo();
        seedLinked(repo);
        const ctx = tagging(contextWith(repo, { kind: 'personal' }));
        const converted = await handlerFor(projectSetSecurityTier)(ctx, { projectId: 1, securityTier: 'guarded' });
        assert.equal(converted.project.securityTier, 'guarded');
        assert.equal(converted.project.title, 'Projet 1');
        assert.equal(converted.project.versionSource, 'manual');

        // Chaque cellule de l'arbre est relue sous le codec gardé, rien ne reste sous
        // l'ancien.
        const tree = [
            repo.rows.projects[0].content,
            repo.rows.columns[0].content,
            repo.rows.cards[0].content,
            repo.rows.messages[0].content,
            repo.rows.milestones[0].content
        ];
        assert.ok(
            tree.every((c) => c.startsWith('private:')),
            tree.join('\n')
        );

        // Les liaisons aux objets d'espace tombent ; les services surveillés, que le
        // module ne relie pas par un contrat d'espace ouvert, restent.
        assert.deepEqual(
            [repo.rows.links.repo, repo.rows.links.database, repo.rows.links.site, repo.rows.links.deploy].map(
                (l) => l.length
            ),
            [0, 0, 0, 0]
        );
        assert.equal(repo.rows.links.uptime.length, 1);

        // Les événements de déliaison sont écrits sous l'ancien étage puis convertis
        // avec le reste ; la conversion elle-même l'est sous le nouveau.
        const kinds = repo.rows.events.map((e) => e.kind);
        assert.deepEqual(kinds, [
            'projects.status',
            'projects.repoUnlink',
            'projects.databaseUnlink',
            'projects.audienceUnlink',
            'projects.deployUnlink',
            'projects.securityTier'
        ]);
        assert.ok(repo.rows.events.every((e) => e.content.startsWith('private:')));
        assert.equal(ctx.recorded.audits[0]?.action, 'projects.setSecurityTier');
    });

    it('exige une session déverrouillée dans les deux sens, et ne touche à rien sinon', async () => {
        const repo = fakeRepo();
        seedLinked(repo);
        const ctx = tagging(contextWith(repo, { kind: 'personal', unlocked: false }));
        ctx.secrecy.isUnlocked = async () => false;
        await assert.rejects(
            handlerFor(projectSetSecurityTier)(ctx, { projectId: 1, securityTier: 'guarded' }),
            failsWith('locked')
        );
        assert.equal(repo.rows.projects[0].security_tier, 'open');
        assert.equal(repo.rows.links.repo.length, 1);
        assert.ok(repo.rows.cards[0].content.startsWith('server:'));
    });

    it('un projet confidentiel n’existe pas dans un espace partagé ; le même étage est un no-op', async () => {
        const repo = fakeRepo();
        seedLinked(repo);
        await assert.rejects(
            handlerFor(projectSetSecurityTier)(tagging(contextWith(repo, { kind: 'shared' })), {
                projectId: 1,
                securityTier: 'guarded'
            }),
            failsWith('validation')
        );
        const same = await handlerFor(projectSetSecurityTier)(tagging(contextWith(repo)), {
            projectId: 1,
            securityTier: 'open'
        });
        assert.equal(same.project.securityTier, 'open');
        assert.equal(repo.rows.links.repo.length, 1);
        assert.deepEqual(
            repo.rows.events.map((e) => e.kind),
            ['projects.status']
        );
    });

    it('revenir en ouvert re-chiffre l’arbre sous le codec ouvert', async () => {
        const repo = fakeRepo();
        repo.rows.projects.push(project({ id: 2, security_tier: 'guarded', content: `private:${body('Secret')}` }));
        repo.rows.cards.push(
            card({
                id: 21,
                project_id: 2,
                column_id: 20,
                content: 'private:{"title":"T","description":"","checklist":[]}'
            })
        );
        const ctx = tagging(contextWith(repo, { kind: 'personal' }));
        const converted = await handlerFor(projectSetSecurityTier)(ctx, { projectId: 2, securityTier: 'open' });
        assert.equal(converted.project.securityTier, 'open');
        assert.ok(repo.rows.projects[0].content.startsWith('server:'));
        assert.ok(repo.rows.cards[0].content.startsWith('server:'));
    });
});

describe('projects.archive / projects.reorder', () => {
    it('archiver un projet ouvert écrit sa ligne de frise et son audit', async () => {
        const repo = fakeRepo();
        seedTwoTiers(repo);
        const ctx = contextWith(repo);
        assert.deepEqual(await handlerFor(projectArchive)(ctx, { projectId: 1 }), { projectId: 1 });
        assert.notEqual(repo.rows.projects[0].archived_at, null);
        assert.deepEqual(
            repo.rows.events.map((e) => e.kind),
            ['projects.archived']
        );
        assert.equal(ctx.recorded.audits[0]?.action, 'projects.archive');
    });

    it('réordonner ne touche aucun corps chiffré : un portefeuille de projets gardés se range session scellée', async () => {
        const repo = fakeRepo();
        seedTwoTiers(repo);
        await handlerFor(projectReorder)(contextWith(repo, { unlocked: false }), { projectIds: [2, 1] });
        assert.deepEqual(
            repo.rows.projects.map((p) => [p.id, p.sort_order]),
            [
                [1, 1],
                [2, 0]
            ]
        );
    });
});

describe('projects.board : le tableau', () => {
    it('répond `locked` sur un projet gardé à une session scellée, et rend colonnes et non-lus déverrouillée', async () => {
        const repo = fakeRepo();
        seedTwoTiers(repo);
        repo.rows.messages.push(
            message({ id: 30, card_id: 21, project_id: 2 }),
            message({ id: 31, card_id: 21, project_id: 2 })
        );
        repo.rows.reads.push({ card_id: 21, user_id: 1, workspace_id: 1, last_read_message_id: 30 });
        await assert.rejects(
            handlerFor(projectBoard)(contextWith(repo, { unlocked: false }), { projectId: 2 }),
            failsWith('locked')
        );
        const board = await handlerFor(projectBoard)(contextWith(repo), { projectId: 2 });
        assert.deepEqual(
            board.columns.map((c) => c.name),
            ['Colonne 20']
        );
        assert.deepEqual(
            board.cards.map((c) => [c.title, c.unread]),
            [['Carte 21', 1]]
        );
    });

    it('l’archive rend les cartes archivées sans colonne', async () => {
        const repo = fakeRepo();
        seedTwoTiers(repo);
        repo.rows.cards.push(card({ id: 12, project_id: 1, column_id: 10, archived_at: 9 }));
        const board = await handlerFor(projectBoard)(contextWith(repo), { projectId: 1, archived: true });
        assert.deepEqual(board.columns, []);
        assert.deepEqual(
            board.cards.map((c) => [c.id, c.archived]),
            [[12, true]]
        );
    });

    it('un tableau ne dépasse pas le plafond de colonnes', async () => {
        const repo = fakeRepo();
        repo.rows.projects.push(project({ id: 1 }));
        for (let i = 0; i < PROJECT_MAX_COLUMNS; i++) repo.rows.columns.push(column({ id: 10 + i, project_id: 1 }));
        await assert.rejects(
            handlerFor(projectColumnAdd)(contextWith(repo), {
                projectId: 1,
                name: 'Une de trop',
                countsAsDone: false,
                wipLimit: null
            }),
            failsWith('validation')
        );
    });

    it('une colonne naît avec son drapeau « terminé » et sa limite', async () => {
        const repo = fakeRepo();
        repo.rows.projects.push(project({ id: 1 }));
        const added = await handlerFor(projectColumnAdd)(contextWith(repo), {
            projectId: 1,
            name: 'Livré',
            countsAsDone: true,
            wipLimit: 3
        });
        assert.deepEqual([added.column.countsAsDone, added.column.wipLimit], [true, 3]);
        const row = repo.rows.columns.find((c) => c.id === added.column.id)!;
        assert.deepEqual([row.counts_as_done, row.wip_limit], [1, 3]);
    });

    it('une colonne ne se retire que vide de cartes vivantes ; les archivées s’en détachent', async () => {
        const repo = fakeRepo();
        seedTwoTiers(repo);
        await assert.rejects(
            handlerFor(projectColumnRemove)(contextWith(repo), { columnId: 10 }),
            failsWith('conflict')
        );

        repo.rows.cards[0].archived_at = 9;
        assert.deepEqual(await handlerFor(projectColumnRemove)(contextWith(repo), { columnId: 10 }), { columnId: 10 });
        assert.ok(!repo.rows.columns.some((c) => c.id === 10));
        assert.equal(repo.rows.cards.find((c) => c.id === 11)?.column_id, null);
    });

    it('restaurer une carte détachée la remet dans la première colonne, et refuse s’il n’y en a plus', async () => {
        const repo = fakeRepo();
        seedTwoTiers(repo);
        repo.rows.cards[0].archived_at = 9;
        repo.rows.cards[0].column_id = null;
        repo.rows.columns = repo.rows.columns.filter((c) => c.project_id !== 1);
        await assert.rejects(handlerFor(projectCardRestore)(contextWith(repo), { cardId: 11 }), failsWith('conflict'));

        repo.rows.columns.push(column({ id: 13, project_id: 1 }));
        assert.deepEqual(await handlerFor(projectCardRestore)(contextWith(repo), { cardId: 11 }), { cardId: 11 });
        const row = repo.rows.cards.find((c) => c.id === 11);
        assert.deepEqual([row?.archived_at, row?.column_id], [null, 13]);
    });
});

describe('projects.cardAdd / cardMove / cardArchive : les cartes', () => {
    const CARD = {
        title: 'Faire',
        description: '',
        checklist: [],
        priority: 'high' as const,
        assigneeUserId: null,
        startDate: null,
        dueDate: null,
        estimateMinutes: null
    };

    it('refuse une colonne d’un autre projet et un assigné qui n’est pas membre ; sinon range la carte', async () => {
        const repo = fakeRepo();
        seedTwoTiers(repo);
        const ctx = contextWith(repo);
        await assert.rejects(
            handlerFor(projectCardAdd)(ctx, { projectId: 1, columnId: 20, card: CARD }),
            failsWith('validation')
        );
        await assert.rejects(
            handlerFor(projectCardAdd)(ctx, { projectId: 1, columnId: 10, card: { ...CARD, assigneeUserId: 2 } }),
            failsWith('validation')
        );
        assert.equal(repo.rows.cards.length, 2);

        const added = await handlerFor(projectCardAdd)(contextWith(repo, { deveye: TWO_MEMBERS }), {
            projectId: 1,
            columnId: 10,
            card: { ...CARD, assigneeUserId: 2 }
        });
        assert.equal(added.card.title, 'Faire');
        assert.equal(added.card.priority, 'high');
        assert.equal(added.card.assigneeUserId, 2);
        assert.equal(repo.rows.cards.at(-1)?.priority, 3);
    });

    it('une carte ne change pas de projet ; sinon le rangement marche sans déverrouiller un projet gardé', async () => {
        const repo = fakeRepo();
        seedTwoTiers(repo);
        const ctx = contextWith(repo, { unlocked: false });
        await assert.rejects(
            handlerFor(projectCardMove)(ctx, { columnId: 20, cardIds: [11] }),
            failsWith('validation')
        );
        repo.rows.columns.push(column({ id: 22, project_id: 2 }));
        await handlerFor(projectCardMove)(ctx, { columnId: 22, cardIds: [21] });
        assert.equal(repo.rows.cards[1].column_id, 22);
    });

    const ITEM = { label: 'Relire', assigneeUserId: null, required: true, createdAt: null, doneAt: null, doneBy: null };

    it('les horodatages d’une sous-tâche viennent du serveur, jamais du client', async () => {
        const repo = fakeRepo();
        seedTwoTiers(repo);
        const ctx = contextWith(repo);
        const forged = { ...ITEM, id: 'a', done: true, doneAt: 5, doneBy: 99, createdAt: 5 };
        const first = await handlerFor(projectCardUpdate)(ctx, { cardId: 11, card: { ...CARD, checklist: [forged] } });
        const [stamped] = first.card.checklist;
        assert.equal(stamped.doneBy, 1);
        assert.ok((stamped.doneAt ?? 0) > 5 && (stamped.createdAt ?? 0) > 5);

        // Déjà cochée : un second envoi, même forgé, reporte ce qui est enregistré.
        const again = await handlerFor(projectCardUpdate)(ctx, {
            cardId: 11,
            card: { ...CARD, checklist: [{ ...forged, doneBy: 42 }] }
        });
        assert.deepEqual(again.card.checklist[0], stamped);

        const undone = await handlerFor(projectCardUpdate)(ctx, {
            cardId: 11,
            card: { ...CARD, checklist: [{ ...forged, done: false }] }
        });
        assert.deepEqual([undone.card.checklist[0].doneAt, undone.card.checklist[0].doneBy], [null, null]);
    });

    it('refuse une sous-tâche assignée à quelqu’un qui n’est pas membre', async () => {
        const repo = fakeRepo();
        seedTwoTiers(repo);
        await assert.rejects(
            handlerFor(projectCardUpdate)(contextWith(repo), {
                cardId: 11,
                card: { ...CARD, checklist: [{ ...ITEM, id: 'a', done: false, assigneeUserId: 2 }] }
            }),
            failsWith('validation')
        );
    });

    it('une sous-tâche obligatoire ouverte ferme l’entrée d’une colonne terminée, pas son rangement', async () => {
        const repo = fakeRepo();
        seedTwoTiers(repo);
        repo.rows.columns.push(column({ id: 12, project_id: 1, counts_as_done: 1 }));
        repo.rows.cards.push(card({ id: 13, project_id: 1, column_id: 12, required_open_count: 1 }));
        const ctx = contextWith(repo);
        await handlerFor(projectCardUpdate)(ctx, {
            cardId: 11,
            card: {
                ...CARD,
                checklist: [
                    { ...ITEM, id: 'a', done: false },
                    { ...ITEM, id: 'b', done: true }
                ]
            }
        });
        assert.equal(repo.rows.cards[0].required_open_count, 1);

        await assert.rejects(
            handlerFor(projectCardMove)(ctx, { columnId: 12, cardIds: [13, 11] }),
            (e: unknown) =>
                failsWith('conflict')(e) &&
                JSON.stringify((e as { details?: unknown }).details) ===
                    JSON.stringify({ cards: [{ cardId: 11, remaining: 1 }] })
        );
        assert.equal(repo.rows.cards[0].column_id, 10);

        // Déjà dans la colonne : la ranger ne bute sur rien.
        await handlerFor(projectCardMove)(ctx, { columnId: 12, cardIds: [13] });
    });

    it('archiver une carte pose son titre dans la frise et une ligne d’audit', async () => {
        const repo = fakeRepo();
        seedTwoTiers(repo);
        const ctx = contextWith(repo);
        await handlerFor(projectCardArchive)(ctx, { cardId: 11 });
        assert.notEqual(repo.rows.cards[0].archived_at, null);
        assert.deepEqual(
            repo.rows.events.map((e) => [e.kind, e.ref_type, e.ref_id, JSON.parse(e.content).label]),
            [['card.archived', 'card', 11, 'Carte 11']]
        );
        assert.equal(ctx.recorded.audits[0]?.action, 'projects.cardArchive');
    });
});

describe('projects.messageSend / messageEdit / messageList : la discussion', () => {
    it('poste un message, ne garde que les mentions de membres, et marque le fil lu pour son auteur', async () => {
        const repo = fakeRepo();
        seedTwoTiers(repo);
        const sent = await handlerFor(projectMessageSend)(contextWith(repo, { deveye: TWO_MEMBERS }), {
            cardId: 11,
            text: 'Bonjour',
            mentions: [2, 3, 2]
        });
        assert.equal(sent.message.text, 'Bonjour');
        assert.deepEqual(sent.message.mentions, [2]);
        assert.equal(repo.rows.cards[0].message_count, 1);
        assert.deepEqual(repo.rows.reads, [
            { card_id: 11, user_id: 1, workspace_id: 1, last_read_message_id: sent.message.id }
        ]);
    });

    it('refuse `locked` de poster sur un projet gardé scellé, et `forbidden` de retoucher les mots d’autrui', async () => {
        const repo = fakeRepo();
        seedTwoTiers(repo);
        repo.rows.messages.push(message({ id: 30, card_id: 11, project_id: 1, author_user_id: 2 }));
        await assert.rejects(
            handlerFor(projectMessageSend)(contextWith(repo, { unlocked: false }), {
                cardId: 21,
                text: 'x',
                mentions: []
            }),
            failsWith('locked')
        );
        await assert.rejects(
            handlerFor(projectMessageEdit)(contextWith(repo), { messageId: 30, text: 'y', mentions: [] }),
            failsWith('forbidden')
        );
        assert.equal(repo.rows.messages.length, 1);
    });

    it('pagine du plus récent au plus ancien et rend chaque page dans l’ordre de lecture', async () => {
        const repo = fakeRepo();
        seedTwoTiers(repo);
        for (const id of [31, 32, 33]) repo.rows.messages.push(message({ id, card_id: 11, project_id: 1 }));
        const ctx = contextWith(repo);
        const last = await handlerFor(projectMessageList)(ctx, { cardId: 11, limit: 2 });
        assert.deepEqual(
            last.messages.map((m) => m.text),
            ['Message 32', 'Message 33']
        );
        assert.equal(last.hasMore, true);
        const previous = await handlerFor(projectMessageList)(ctx, { cardId: 11, limit: 2, before: 32 });
        assert.deepEqual(
            previous.messages.map((m) => m.text),
            ['Message 31']
        );
        assert.equal(previous.hasMore, false);
    });
});

describe('projects.depAdd / milestoneSetReached / cardSetMilestone : la frise', () => {
    it('refuse une carte qui se bloque elle-même, un cycle et une dépendance entre deux projets', async () => {
        const repo = fakeRepo();
        seedTwoTiers(repo);
        repo.rows.cards.push(card({ id: 12, project_id: 1, column_id: 10 }));
        const ctx = contextWith(repo);
        await assert.rejects(
            handlerFor(projectDepAdd)(ctx, { cardId: 11, blockedByCardId: 11 }),
            failsWith('validation')
        );
        await assert.rejects(
            handlerFor(projectDepAdd)(ctx, { cardId: 11, blockedByCardId: 21 }),
            failsWith('validation')
        );
        await handlerFor(projectDepAdd)(ctx, { cardId: 11, blockedByCardId: 12 });
        await assert.rejects(
            handlerFor(projectDepAdd)(ctx, { cardId: 12, blockedByCardId: 11 }),
            failsWith('validation')
        );
        assert.deepEqual(
            repo.rows.deps.map((d) => [d.card_id, d.blocked_by_card_id]),
            [[11, 12]]
        );
    });

    it('seule l’atteinte d’un jalon entre dans la frise, sous son nom', async () => {
        const repo = fakeRepo();
        seedTwoTiers(repo);
        repo.rows.milestones.push({
            id: 40,
            project_id: 1,
            workspace_id: 1,
            due_date: 10,
            reached_at: null,
            sort_order: 0,
            content: JSON.stringify({ name: 'Bêta', description: '' }),
            created: 1
        });
        const ctx = contextWith(repo);
        const unreached = await handlerFor(projectMilestoneSetReached)(ctx, { milestoneId: 40, reached: false });
        assert.equal(unreached.milestone.reachedAt, null);
        assert.equal(repo.rows.events.length, 0);
        const reached = await handlerFor(projectMilestoneSetReached)(ctx, { milestoneId: 40, reached: true });
        assert.notEqual(reached.milestone.reachedAt, null);
        assert.deepEqual(
            repo.rows.events.map((e) => [e.kind, e.ref_type, e.ref_id, JSON.parse(e.content).label]),
            [['milestone.reached', 'milestone', 40, 'Bêta']]
        );
    });

    it('un jalon d’un autre projet ne se rattache pas à une carte', async () => {
        const repo = fakeRepo();
        seedTwoTiers(repo);
        repo.rows.milestones.push({
            id: 40,
            project_id: 2,
            workspace_id: 1,
            due_date: 10,
            reached_at: null,
            sort_order: 0,
            content: JSON.stringify({ name: 'Ailleurs', description: '' }),
            created: 1
        });
        await assert.rejects(
            handlerFor(projectCardSetMilestone)(contextWith(repo), { cardId: 11, milestoneId: 40 }),
            failsWith('validation')
        );
        assert.equal(repo.rows.cards[0].milestone_id, null);
    });
});

describe('projects.eventList : l’historique', () => {
    it('pagine du plus récent au plus ancien, libellés déchiffrés, et répond `locked` sur un projet gardé scellé', async () => {
        const repo = fakeRepo();
        seedTwoTiers(repo);
        for (const id of [50, 51, 52]) repo.rows.events.push(event({ id, project_id: 1 }));
        const page = await handlerFor(projectEventList)(contextWith(repo), { projectId: 1, limit: 2 });
        assert.deepEqual(
            page.events.map((e) => e.label),
            ['Événement 52', 'Événement 51']
        );
        assert.equal(page.hasMore, true);
        await assert.rejects(
            handlerFor(projectEventList)(contextWith(repo, { unlocked: false }), { projectId: 2 }),
            failsWith('locked')
        );
    });
});

describe('les liaisons par les contrats d’éléments', () => {
    it('relier un dépôt : module absent = refus propre, dépôt inconnu = introuvable, projet confidentiel = refus ; sinon la liaison, sa frise et son audit', async () => {
        const repo = fakeRepo();
        seedTwoTiers(repo);
        await assert.rejects(
            handlerFor(projectRepoLink)(contextWith(repo), { projectId: 1, repoId: 5 }),
            failsWith('validation')
        );
        const providers = { [GIT_ITEMS_PROVIDER]: { exists: async (id: number, ws: number) => id === 5 && ws === 1 } };
        await assert.rejects(
            handlerFor(projectRepoLink)(contextWith(repo, { providers }), { projectId: 1, repoId: 6 }),
            failsWith('not_found')
        );
        await assert.rejects(
            handlerFor(projectRepoLink)(contextWith(repo, { providers }), { projectId: 2, repoId: 5 }),
            failsWith('validation')
        );
        assert.equal(repo.rows.links.repo.length, 0);

        const ctx = contextWith(repo, { providers });
        const linked = await handlerFor(projectRepoLink)(ctx, { projectId: 1, repoId: 5 });
        assert.deepEqual(linked.repoIds, [5]);
        assert.deepEqual(
            repo.rows.events.map((e) => e.kind),
            ['projects.repoLink']
        );
        assert.equal(ctx.recorded.audits[0]?.action, 'projects.repoLink');
        // Idempotente : le même fait déclaré deux fois n'est pas un doublon.
        assert.deepEqual((await handlerFor(projectRepoLink)(ctx, { projectId: 1, repoId: 5 })).repoIds, [5]);
    });

    it('les bases, les sites et les cibles suivent la même règle : sans leur module, rien ne se relie', async () => {
        const repo = fakeRepo();
        seedTwoTiers(repo);
        const ctx = contextWith(repo);
        await assert.rejects(
            handlerFor(projectDatabaseLink)(ctx, { projectId: 1, databaseId: 6 }),
            failsWith('validation')
        );
        await assert.rejects(
            handlerFor(projectAudienceLink)(ctx, { projectId: 1, siteId: 7 }),
            failsWith('validation')
        );
        await assert.rejects(
            handlerFor(projectDeployLink)(ctx, { projectId: 1, targetId: 8 }),
            failsWith('validation')
        );
        const providers = {
            [DATABASE_ITEMS_PROVIDER]: { exists: async () => true },
            [AUDIENCE_ITEMS_PROVIDER]: { exists: async () => true },
            [DEPLOY_ITEMS_PROVIDER]: { exists: async () => true }
        };
        const linking = contextWith(repo, { providers });
        assert.deepEqual(
            (await handlerFor(projectDatabaseLink)(linking, { projectId: 1, databaseId: 6 })).databaseIds,
            [6]
        );
        assert.deepEqual((await handlerFor(projectAudienceLink)(linking, { projectId: 1, siteId: 7 })).siteIds, [7]);
        assert.deepEqual((await handlerFor(projectDeployLink)(linking, { projectId: 1, targetId: 8 })).targetIds, [8]);
    });

    it('un service surveillé se rattache par le contrat d’Uptime, et se détache sans y toucher', async () => {
        const repo = fakeRepo();
        seedTwoTiers(repo);
        const providers = { [UPTIME_ITEMS_PROVIDER]: { exists: async (id: number) => id === 9 } };
        const ctx = contextWith(repo, { providers });
        await assert.rejects(
            handlerFor(projectUptimeLink)(ctx, { projectId: 1, serviceId: 10 }),
            failsWith('not_found')
        );
        assert.deepEqual((await handlerFor(projectUptimeLink)(ctx, { projectId: 1, serviceId: 9 })).serviceIds, [9]);
        assert.deepEqual((await handlerFor(projectUptimeUnlink)(ctx, { projectId: 1, serviceId: 9 })).serviceIds, []);
    });

    it('les compteurs d’onglets lisent les liaisons en clair, une clé par feature reliée', async () => {
        const repo = fakeRepo();
        seedTwoTiers(repo);
        repo.rows.links.repo.push({ project_id: 1, workspace_id: 1, item_id: 5 });
        repo.rows.links.database.push(
            { project_id: 1, workspace_id: 1, item_id: 6 },
            { project_id: 1, workspace_id: 1, item_id: 7 }
        );
        repo.rows.links.deploy.push({ project_id: 1, workspace_id: 1, item_id: 8 });
        repo.rows.links.uptime.push({ project_id: 1, workspace_id: 1, item_id: 9 });
        const counted = await handlerFor(projectLinkCounts)(contextWith(repo, { unlocked: false }), { projectId: 1 });
        assert.deepEqual(counted.counts, { git: 1, database: 2, audience: 0, deploy: 1, uptime: 1 });
    });
});

describe('projects.myTasks : mes tâches à travers les projets', () => {
    it('masque la carte d’un projet gardé quand la session est scellée, plutôt que de la taire', async () => {
        const repo = fakeRepo();
        seedTwoTiers(repo);
        repo.rows.cards[0].assignee_user_id = 1;
        repo.rows.cards[1].assignee_user_id = 1;
        const sealed = await handlerFor(projectMyTasks)(contextWith(repo, { unlocked: false }), {});
        assert.deepEqual(
            sealed.tasks.map((t) => [t.projectId, t.projectTitle, t.card.title, t.masked]),
            [
                [1, 'Projet 1', 'Carte 11', false],
                [2, '', '', true]
            ]
        );
        const open = await handlerFor(projectMyTasks)(contextWith(repo), {});
        assert.deepEqual(
            open.tasks.map((t) => [t.projectTitle, t.card.title, t.masked]),
            [
                ['Projet 1', 'Carte 11', false],
                ['Secret', 'Carte 21', false]
            ]
        );
    });
});

describe('le partage inter-espaces', () => {
    /**
     * Un projet projeté : le projet 1 vit dans l'espace 42, avec sa colonne 10 et sa
     * carte 11, tout son arbre sous le codec ouvert de son domicile (`home:`) ; il se
     * projette vers l'espace 1, où vit le projet 2 (`server:`, colonne 20, carte 21).
     */
    function projected(over: Omit<TestContextOverrides<FakeRepo>, 'repo' | 'workspaceId' | 'shares'> = {}) {
        const repo = fakeRepo({ 1: [1] });
        repo.rows.projects.push(
            project({ id: 1, workspace_id: 42, content: `home:${body('Partagé')}` }),
            project({ id: 2, content: `server:${body('Local')}` })
        );
        repo.rows.columns.push(
            column({ id: 10, project_id: 1, workspace_id: 42, content: 'home:{"name":"À faire"}' }),
            column({ id: 20, project_id: 2, content: 'server:{"name":"Ici"}' })
        );
        repo.rows.cards.push(
            card({
                id: 11,
                project_id: 1,
                column_id: 10,
                workspace_id: 42,
                content: 'home:{"title":"Partagée","description":"","checklist":[]}'
            }),
            card({
                id: 21,
                project_id: 2,
                column_id: 20,
                content: 'server:{"title":"Locale","description":"","checklist":[]}'
            })
        );
        const home = homeTagging(contextWith(repo, { workspaceId: 42, kind: 'shared' }));
        const window = windowTagging(contextWith(repo, { workspaceId: 1, shares: { 1: 42 }, ...over }));
        return { repo, home, window };
    }

    const CARD = {
        title: 'Faire',
        description: '',
        checklist: [],
        priority: 'normal' as const,
        assigneeUserId: null,
        startDate: null,
        dueDate: null,
        estimateMinutes: null
    };

    it('liste un projet projeté avec sa pastille, sous le codec de son domicile, ses compteurs et les non-lus de l’appelant, et le compte', async () => {
        const { repo, window } = projected();
        repo.rows.messages.push(
            message({
                id: 30,
                card_id: 11,
                project_id: 1,
                workspace_id: 42,
                author_user_id: 7,
                content: 'home:{"text":"Salut"}'
            })
        );

        // Les locaux d'abord, puis les projetés ; les compteurs et les non-lus d'un
        // projet projeté sont ceux de l'appelant, comme chez lui.
        const listed = await handlerFor(projectList)(window, {});
        assert.deepEqual(
            listed.projects.map((p) => [
                p.project.id,
                p.project.title,
                p.foreign,
                p.project.foreign,
                p.cardTotal,
                p.unread
            ]),
            [
                [2, 'Local', false, false, 1, 0],
                [1, 'Partagé', true, true, 1, 1]
            ]
        );
        assert.deepEqual(await handlerFor(projectCount)(window, {}), { count: 2 });
        const read = await handlerFor(projectGet)(window, { projectId: 1 });
        assert.deepEqual([read.project.foreign, read.project.title], [true, 'Partagé']);

        // Masqué pour ce rôle : disparaît de la liste et du compte, et ne s'ouvre pas.
        const restricted = windowTagging(
            contextWith(repo, { workspaceId: 1, shares: { 1: 42 }, itemRestrictions: { 1: 'none' } })
        );
        assert.deepEqual(
            (await handlerFor(projectList)(restricted, {})).projects.map((p) => p.project.id),
            [2]
        );
        assert.deepEqual(await handlerFor(projectCount)(restricted, {}), { count: 1 });
        await assert.rejects(handlerFor(projectGet)(restricted, { projectId: 1 }), failsWith('forbidden'));

        // Et depuis un espace qui ne le voit pas : introuvable, sans rien trahir.
        await assert.rejects(
            handlerFor(projectGet)(contextWith(repo, { workspaceId: 9 }), { projectId: 1 }),
            failsWith('not_found')
        );
    });

    it('lit le tableau, la frise, l’historique et la discussion d’un projet projeté depuis la fenêtre, sous le codec de son domicile', async () => {
        const { repo, window } = projected();
        repo.rows.messages.push(
            message({
                id: 30,
                card_id: 11,
                project_id: 1,
                workspace_id: 42,
                author_user_id: 7,
                content: 'home:{"text":"Salut"}'
            })
        );
        repo.rows.milestones.push({
            id: 40,
            project_id: 1,
            workspace_id: 42,
            due_date: 10,
            reached_at: null,
            sort_order: 0,
            content: 'home:{"name":"Bêta","description":""}',
            created: 1
        });
        repo.rows.events.push(
            event({
                id: 50,
                project_id: 1,
                workspace_id: 42,
                actor_user_id: 7,
                content: 'home:{"label":"Créé","from":null,"to":null}'
            })
        );

        const board = await handlerFor(projectBoard)(window, { projectId: 1 });
        assert.deepEqual(
            board.columns.map((c) => c.name),
            ['À faire']
        );
        assert.deepEqual(
            board.cards.map((c) => [c.title, c.unread]),
            [['Partagée', 1]]
        );
        const plan = await handlerFor(projectPlan)(window, { projectId: 1 });
        assert.deepEqual(
            plan.milestones.map((m) => m.name),
            ['Bêta']
        );
        // Les acteurs et les auteurs voyagent en identifiants : c'est le client qui
        // nomme parmi les membres d'ici, et masque les autres.
        const history = await handlerFor(projectEventList)(window, { projectId: 1 });
        assert.deepEqual(
            history.events.map((e) => [e.label, e.actorUserId]),
            [['Créé', 7]]
        );
        const thread = await handlerFor(projectMessageList)(window, { cardId: 11 });
        assert.deepEqual(
            thread.messages.map((m) => [m.text, m.authorUserId]),
            [['Salut', 7]]
        );
    });

    it('écrit le tableau et la frise d’un projet projeté depuis la fenêtre : chez lui, sous son codec, assigné parmi les membres d’ici', async () => {
        const { repo, home, window } = projected({ deveye: TWO_MEMBERS });

        const added = await handlerFor(projectCardAdd)(window, {
            projectId: 1,
            columnId: 10,
            card: { ...CARD, assigneeUserId: 2 }
        });
        const row = repo.rows.cards.find((c) => c.id === added.card.id)!;
        assert.deepEqual([row.workspace_id, row.assignee_user_id, row.content.startsWith('home:')], [42, 2, true]);
        // Chez lui, où 2 n'est pas membre, le même assigné est refusé : la garde est
        // celle de l'espace actif.
        await assert.rejects(
            handlerFor(projectCardAdd)(home, { projectId: 1, columnId: 10, card: { ...CARD, assigneeUserId: 2 } }),
            failsWith('validation')
        );

        const col = await handlerFor(projectColumnAdd)(window, {
            projectId: 1,
            name: 'Relecture',
            countsAsDone: false,
            wipLimit: null
        });
        const colRow = repo.rows.columns.find((c) => c.id === col.column.id)!;
        assert.deepEqual([colRow.workspace_id, colRow.content], [42, 'home:{"name":"Relecture"}']);

        const milestone = await handlerFor(projectMilestoneAdd)(window, {
            projectId: 1,
            milestone: { name: 'V1', description: '', color: null, dueDate: 20 }
        });
        const milestoneRow = repo.rows.milestones.find((m) => m.id === milestone.milestone.id)!;
        assert.deepEqual([milestoneRow.workspace_id, milestoneRow.content.startsWith('home:')], [42, true]);

        await handlerFor(projectDepAdd)(window, { cardId: added.card.id, blockedByCardId: 11 });
        assert.deepEqual(
            repo.rows.deps.map((d) => [d.card_id, d.blocked_by_card_id, d.project_id]),
            [[added.card.id, 11, 1]]
        );
        // Une dépendance ne traverse pas la fenêtre : la carte 21 est d'ici.
        await assert.rejects(
            handlerFor(projectDepAdd)(window, { cardId: 11, blockedByCardId: 21 }),
            failsWith('validation')
        );

        // La frise de l'archivage est écrite chez lui, sous son codec.
        await handlerFor(projectCardArchive)(window, { cardId: 11 });
        const archived = repo.rows.events.at(-1)!;
        assert.deepEqual(
            [
                archived.project_id,
                archived.workspace_id,
                archived.actor_user_id,
                archived.kind,
                archived.content.startsWith('home:')
            ],
            [1, 42, 1, 'card.archived', true]
        );
    });

    it('écrit la discussion et le profil d’un projet projeté depuis la fenêtre, et l’archive chez lui', async () => {
        const { repo, window } = projected({ deveye: TWO_MEMBERS });

        const sent = await handlerFor(projectMessageSend)(window, { cardId: 11, text: 'Bonjour', mentions: [2, 3] });
        const msg = repo.rows.messages.find((m) => m.id === sent.message.id)!;
        assert.deepEqual(
            [msg.workspace_id, msg.author_user_id, sent.message.mentions, msg.content.startsWith('home:')],
            [42, 1, [2], true]
        );
        // Le point de lecture reste celui de l'appelant, posé chez le projet.
        assert.deepEqual(repo.rows.reads, [
            { card_id: 11, user_id: 1, workspace_id: 42, last_read_message_id: sent.message.id }
        ]);

        const updated = await handlerFor(projectUpdate)(window, {
            projectId: 1,
            project: { ...DRAFT, title: 'Partagé, relu', status: 'paused' }
        });
        assert.deepEqual([updated.project.title, updated.project.foreign], ['Partagé, relu', true]);
        const row = repo.rows.projects.find((p) => p.id === 1)!;
        assert.deepEqual([row.workspace_id, row.content.startsWith('home:')], [42, true]);
        assert.deepEqual(
            repo.rows.events.map((e) => [e.kind, e.workspace_id, e.content.startsWith('home:')]),
            [
                ['projects.renamed', 42, true],
                ['projects.status', 42, true]
            ]
        );

        const versioned = await handlerFor(projectSetVersion)(window, {
            projectId: 1,
            source: 'manual',
            version: '1.0.0'
        });
        assert.deepEqual([versioned.project.version, versioned.project.foreign], ['1.0.0', true]);
        const status = await handlerFor(projectSetStatus)(window, { projectId: 1, status: 'done' });
        assert.deepEqual([status.project.status, status.project.foreign], ['done', true]);

        await handlerFor(projectArchive)(window, { projectId: 1 });
        assert.notEqual(row.archived_at, null);
        assert.deepEqual(
            (await handlerFor(projectList)(window, { archived: true })).projects.map((p) => [p.project.id, p.foreign]),
            [[1, true]]
        );
        assert.deepEqual(
            (await handlerFor(projectList)(window, {})).projects.map((p) => p.project.id),
            [2]
        );
        await handlerFor(projectRestore)(window, { projectId: 1 });
        assert.deepEqual([row.archived_at, row.workspace_id], [null, 42]);
    });

    it('compte les cartes d’un projet projeté dans mes tâches, sous son titre, et tait celles d’un projet masqué pour ce rôle', async () => {
        const { repo, window } = projected();
        repo.rows.cards[0].assignee_user_id = 1;
        repo.rows.cards[1].assignee_user_id = 1;
        const mine = await handlerFor(projectMyTasks)(window, {});
        assert.deepEqual(
            mine.tasks.map((t) => [t.projectId, t.projectTitle, t.card.title, t.masked]),
            [
                [1, 'Partagé', 'Partagée', false],
                [2, 'Local', 'Locale', false]
            ]
        );
        const restricted = windowTagging(
            contextWith(repo, { workspaceId: 1, shares: { 1: 42 }, itemRestrictions: { 1: 'none' } })
        );
        assert.deepEqual(
            (await handlerFor(projectMyTasks)(restricted, {})).tasks.map((t) => t.projectId),
            [2]
        );
    });

    it('nomme les liaisons par le contrat d’éléments, au domicile du projet, chez soi comme depuis la fenêtre, et `null` sans module ou sans élément', async () => {
        const { repo } = projected();
        repo.rows.links.repo.push({ project_id: 1, workspace_id: 42, item_id: 5 });
        repo.rows.links.database.push({ project_id: 1, workspace_id: 42, item_id: 6 });
        repo.rows.links.site.push({ project_id: 1, workspace_id: 42, item_id: 7 });
        repo.rows.links.deploy.push({ project_id: 1, workspace_id: 42, item_id: 8 });
        repo.rows.links.uptime.push({ project_id: 1, workspace_id: 42, item_id: 9 });
        // Chaque contrat ne nomme qu'au domicile (42) ; la base 6 a disparu.
        const naming = (noun: string) => ({
            exists: async () => true,
            labelOf: async (id: number, ws: number) => (ws === 42 && id !== 6 ? `${noun} ${id}` : null)
        });
        const providers = {
            [GIT_ITEMS_PROVIDER]: naming('Dépôt'),
            [DATABASE_ITEMS_PROVIDER]: naming('Base'),
            [AUDIENCE_ITEMS_PROVIDER]: naming('Site'),
            [DEPLOY_ITEMS_PROVIDER]: naming('Cible'),
            [UPTIME_ITEMS_PROVIDER]: naming('Service')
        };
        const home = contextWith(repo, { workspaceId: 42, kind: 'shared', providers });
        const window = contextWith(repo, { workspaceId: 1, shares: { 1: 42 }, providers });
        for (const ctx of [home, window]) {
            assert.deepEqual(await handlerFor(projectRepoList)(ctx, { projectId: 1 }), {
                repoIds: [5],
                labels: [{ id: 5, label: 'Dépôt 5' }]
            });
            assert.deepEqual(await handlerFor(projectDatabaseList)(ctx, { projectId: 1 }), {
                databaseIds: [6],
                labels: [{ id: 6, label: null }]
            });
            assert.deepEqual(await handlerFor(projectAudienceList)(ctx, { projectId: 1 }), {
                siteIds: [7],
                labels: [{ id: 7, label: 'Site 7' }]
            });
            assert.deepEqual(await handlerFor(projectDeployList)(ctx, { projectId: 1 }), {
                targetIds: [8],
                labels: [{ id: 8, label: 'Cible 8' }]
            });
            assert.deepEqual(await handlerFor(projectUptimeList)(ctx, { projectId: 1 }), {
                serviceIds: [9],
                labels: [{ id: 9, label: 'Service 9' }]
            });
        }
        // Sans module, les identifiants restent et les noms valent `null` ; les
        // compteurs d'onglets se lisent au domicile, depuis la fenêtre.
        const bare = contextWith(repo, { workspaceId: 1, shares: { 1: 42 } });
        assert.deepEqual(await handlerFor(projectRepoList)(bare, { projectId: 1 }), {
            repoIds: [5],
            labels: [{ id: 5, label: null }]
        });
        assert.deepEqual((await handlerFor(projectLinkCounts)(bare, { projectId: 1 })).counts, {
            git: 1,
            database: 1,
            audience: 1,
            deploy: 1,
            uptime: 1
        });
    });

    it('refuse depuis la fenêtre ce qui référence l’espace d’origine : liaisons, palier, suivi des releases, classement', async () => {
        const { repo, window } = projected();
        repo.rows.links.repo.push({ project_id: 1, workspace_id: 42, item_id: 5 });
        const present = { exists: async () => true, labelOf: async () => null };
        const linking = contextWith(repo, {
            workspaceId: 1,
            shares: { 1: 42 },
            providers: {
                [GIT_ITEMS_PROVIDER]: present,
                [DATABASE_ITEMS_PROVIDER]: present,
                [AUDIENCE_ITEMS_PROVIDER]: present,
                [DEPLOY_ITEMS_PROVIDER]: present,
                [UPTIME_ITEMS_PROVIDER]: present
            }
        });
        const refused = failsWith('validation');
        await assert.rejects(handlerFor(projectRepoLink)(linking, { projectId: 1, repoId: 6 }), refused);
        await assert.rejects(handlerFor(projectRepoUnlink)(linking, { projectId: 1, repoId: 5 }), refused);
        await assert.rejects(handlerFor(projectUptimeLink)(linking, { projectId: 1, serviceId: 9 }), refused);
        await assert.rejects(handlerFor(projectUptimeUnlink)(linking, { projectId: 1, serviceId: 9 }), refused);
        await assert.rejects(handlerFor(projectDatabaseLink)(linking, { projectId: 1, databaseId: 6 }), refused);
        await assert.rejects(handlerFor(projectDatabaseUnlink)(linking, { projectId: 1, databaseId: 6 }), refused);
        await assert.rejects(handlerFor(projectAudienceLink)(linking, { projectId: 1, siteId: 7 }), refused);
        await assert.rejects(handlerFor(projectAudienceUnlink)(linking, { projectId: 1, siteId: 7 }), refused);
        await assert.rejects(handlerFor(projectDeployLink)(linking, { projectId: 1, targetId: 8 }), refused);
        await assert.rejects(handlerFor(projectDeployUnlink)(linking, { projectId: 1, targetId: 8 }), refused);
        assert.deepEqual(
            [
                repo.rows.links.repo,
                repo.rows.links.uptime,
                repo.rows.links.database,
                repo.rows.links.site,
                repo.rows.links.deploy
            ].map((l) => l.length),
            [1, 0, 0, 0, 0]
        );

        await assert.rejects(
            handlerFor(projectSetSecurityTier)(window, { projectId: 1, securityTier: 'guarded' }),
            refused
        );
        await assert.rejects(
            handlerFor(projectSetVersion)(window, { projectId: 1, source: 'github_release', version: '' }),
            refused
        );
        await assert.rejects(handlerFor(projectReorder)(window, { projectIds: [1, 2] }), refused);
        assert.deepEqual(
            repo.rows.projects.map((p) => [p.id, p.security_tier, p.version_source, p.sort_order]),
            [
                [1, 'open', 'manual', 1],
                [2, 'open', 'manual', 2]
            ]
        );
        assert.deepEqual(window.forgotten, []);
        assert.equal(repo.rows.events.length, 0);
        // Le portefeuille d'ici se range sans lui.
        assert.deepEqual(await handlerFor(projectReorder)(window, { projectIds: [2] }), { projectIds: [2] });
    });

    it('passer un projet en confidentiel chez lui oublie ses projections et ses restrictions, et ses fenêtres ne le voient plus', async () => {
        // Le projet 1 vit dans l'espace 1 (personnel) et se projette vers le 7.
        const projections: Record<number, number[]> = { 1: [7] };
        const repo = fakeRepo(projections);
        repo.rows.projects.push(project({ id: 1, content: `server:${body('Bientôt secret')}` }));
        repo.rows.columns.push(column({ id: 10, project_id: 1, content: 'server:{"name":"À faire"}' }));
        const home = tagging(contextWith(repo, { kind: 'personal' }));
        const window = windowTagging(contextWith(repo, { workspaceId: 7, kind: 'shared', shares: { 1: 1 } }), 'server');
        assert.deepEqual(
            (await handlerFor(projectList)(window, {})).projects.map((p) => [p.project.id, p.foreign]),
            [[1, true]]
        );

        // Le ménage est demandé à l'app une seule fois, et seulement vers le palier
        // gardé.
        await handlerFor(projectSetSecurityTier)(home, { projectId: 1, securityTier: 'guarded' });
        assert.deepEqual(home.forgotten, ['1']);
        assert.equal(repo.rows.projects[0].security_tier, 'guarded');
        // Avant même le ménage de l'app, la fenêtre ne voit plus un projet gardé : la
        // projection ne rend que l'étage ouvert.
        assert.deepEqual((await handlerFor(projectList)(window, {})).projects, []);
        await assert.rejects(handlerFor(projectGet)(window, { projectId: 1 }), failsWith('not_found'));
        await handlerFor(projectSetSecurityTier)(home, { projectId: 1, securityTier: 'open' });
        assert.deepEqual(home.forgotten, ['1']);

        // Après l'oubli, la projection n'existe plus et la fenêtre ne voit plus rien,
        // ni en liste, ni au compte, ni par l'id.
        projections[1] = [];
        const after = windowTagging(contextWith(repo, { workspaceId: 7, kind: 'shared' }), 'server');
        assert.deepEqual((await handlerFor(projectList)(after, {})).projects, []);
        assert.deepEqual(await handlerFor(projectCount)(after, {}), { count: 0 });
        await assert.rejects(handlerFor(projectGet)(after, { projectId: 1 }), failsWith('not_found'));
    });
});

describe("l'entrée items", () => {
    it('donne le domicile d’un projet visible, son titre à l’étage ouvert, et refuse de projeter un projet gardé', async () => {
        const repo = fakeRepo({ 1: [7] });
        repo.rows.projects.push(
            project({ id: 1 }),
            project({ id: 2, content: body('') }),
            project({ id: 3, security_tier: 'guarded', content: body('Secret') })
        );
        const items = serverEntry.items!;

        // Chez lui, par sa fenêtre, et depuis un espace qui ne le voit pas.
        assert.equal(await items.homeOf(repo, '1', 1), 1);
        assert.equal(await items.homeOf(repo, '1', 7), 1);
        assert.equal(await items.homeOf(repo, '1', 9), null);
        assert.equal(await items.homeOf(repo, '99', 1), null);

        // Le titre à l'étage ouvert, demandé avec le domicile ; un projet gardé,
        // disparu ou d'ailleurs vaut `null`.
        const open = contextWith(repo).cipher();
        assert.equal(await items.labelOf(repo, open, '1', 1), 'Projet 1');
        assert.equal(await items.labelOf(repo, open, '2', 1), 'Sans titre');
        assert.equal(await items.labelOf(repo, open, '3', 1), null);
        assert.equal(await items.labelOf(repo, open, '99', 1), null);
        assert.equal(await items.labelOf(repo, open, '1', 7), null);

        assert.equal(await items.shareable!(repo, '1', 1), true);
        assert.equal(await items.shareable!(repo, '3', 1), false);
        assert.equal(await items.shareable!(repo, '99', 1), false);
    });
});

describe('la vue d’ensemble d’un projet', () => {
    it('rend l’agencement et les liaisons en une fois, sans déverrouiller un projet gardé', async () => {
        const repo = fakeRepo();
        seedTwoTiers(repo);
        repo.rows.links.database.push({ project_id: 1, workspace_id: 1, item_id: 6 });
        repo.rows.links.uptime.push({ project_id: 1, workspace_id: 1, item_id: 9 });
        const ctx = contextWith(repo, { unlocked: false });

        const first = await handlerFor(projectDashboard)(ctx, { projectId: 1 });
        // Rien n'est semé : le catalogue est du code, la table ne porte que
        // ce qui a été arrangé.
        assert.deepEqual(first.tiles, []);
        assert.deepEqual(first.links, { git: [], database: [6], audience: [], deploy: [], uptime: [9] });
        assert.deepEqual(first.counts, { git: 0, database: 1, audience: 0, deploy: 0, uptime: 1 });

        // Le projet gardé se lit quand même : rangs et masquages sont en clair.
        const guarded = await handlerFor(projectDashboard)(ctx, { projectId: 2 });
        assert.deepEqual(guarded.tiles, []);
    });

    it('range les tuiles, masque, et oublie une tuile automatique qui quitte le catalogue', async () => {
        const repo = fakeRepo();
        seedTwoTiers(repo);
        const ctx = contextWith(repo);

        const arranged = await handlerFor(projectDashboardArrange)(ctx, {
            projectId: 1,
            tiles: [
                { key: 'tasks.due', hidden: false },
                { key: 'tasks.counts', hidden: true }
            ]
        });
        assert.deepEqual(
            arranged.tiles.map((t) => [t.key, t.sortOrder, t.hidden]),
            [
                ['tasks.due', 0, false],
                ['tasks.counts', 1, true]
            ]
        );

        const after = await handlerFor(projectDashboardArrange)(ctx, {
            projectId: 1,
            tiles: [{ key: 'tasks.due', hidden: false }]
        });
        assert.deepEqual(
            after.tiles.map((t) => t.key),
            ['tasks.due']
        );

        await assert.rejects(
            handlerFor(projectDashboardArrange)(ctx, {
                projectId: 1,
                tiles: [
                    { key: 'tasks.due', hidden: false },
                    { key: 'tasks.due', hidden: true }
                ]
            }),
            failsWith('validation')
        );
    });

    it('n’accepte un indicateur que sur une base reliée, en lecture seule, et jamais sur un projet gardé', async () => {
        const repo = fakeRepo();
        seedTwoTiers(repo);
        repo.rows.links.database.push({ project_id: 1, workspace_id: 1, item_id: 6 });
        const ctx = contextWith(repo);
        const kpi = {
            title: 'Commandes',
            sql: 'SELECT COUNT(*) FROM orders',
            unit: '',
            comparator: null,
            threshold: null
        };

        // Une base que le projet ne relie pas n'est pas mesurable.
        await assert.rejects(
            handlerFor(projectDashboardKpiSave)(ctx, { projectId: 1, databaseId: 7, kpi }),
            failsWith('validation')
        );
        // Une écriture déguisée en lecture non plus.
        await assert.rejects(
            handlerFor(projectDashboardKpiSave)(ctx, {
                projectId: 1,
                databaseId: 6,
                kpi: { ...kpi, sql: 'DELETE FROM orders' }
            }),
            failsWith('validation')
        );
        await assert.rejects(
            handlerFor(projectDashboardKpiSave)(ctx, {
                projectId: 1,
                databaseId: 6,
                kpi: { ...kpi, sql: 'SELECT 1; DROP TABLE orders' }
            }),
            failsWith('validation')
        );
        // Un projet confidentiel ne relie aucune base, donc n'en mesure aucune.
        await assert.rejects(
            handlerFor(projectDashboardKpiSave)(ctx, { projectId: 2, databaseId: 6, kpi }),
            failsWith('validation')
        );

        const saved = await handlerFor(projectDashboardKpiSave)(ctx, { projectId: 1, databaseId: 6, kpi });
        const tile = saved.tiles.find((t) => t.kpi !== null);
        assert.ok(tile, 'l’indicateur est rendu');
        assert.ok(tile.key.startsWith('kpi:'), 'sa clé le distingue d’une tuile automatique');
        assert.equal(tile.kpi?.databaseId, 6);
        assert.equal(tile.kpi?.title, 'Commandes');

        // Le retrait est la seule suppression du tableau de bord.
        const removed = await handlerFor(projectDashboardKpiRemove)(ctx, { projectId: 1, tileKey: tile.key });
        assert.deepEqual(removed.tiles, []);
        await assert.rejects(
            handlerFor(projectDashboardKpiRemove)(ctx, { projectId: 1, tileKey: tile.key }),
            failsWith('not_found')
        );
    });

    it('mesure par le contrat du module, groupé par base, et garde le dernier nombre sur un échec', async () => {
        const repo = fakeRepo();
        seedTwoTiers(repo);
        repo.rows.links.database.push({ project_id: 1, workspace_id: 1, item_id: 6 });
        const calls: { databaseId: number; queries: readonly string[] }[] = [];
        let answer: { value: number | null; error: string | null }[] = [{ value: 42, error: null }];
        const ctx = contextWith(repo, {
            providers: {
                [DATABASE_MEASURE_PROVIDER]: {
                    measure: async (databaseId: number, _ws: number, queries: readonly string[]) => {
                        calls.push({ databaseId, queries });
                        return answer;
                    }
                }
            }
        });
        const kpi = {
            title: 'Commandes',
            sql: 'SELECT COUNT(*) FROM orders',
            unit: '',
            comparator: null,
            threshold: null
        };
        const saved = await handlerFor(projectDashboardKpiSave)(ctx, { projectId: 1, databaseId: 6, kpi });
        const key = saved.tiles.find((t) => t.kpi !== null)?.key as string;

        const run = await handlerFor(projectDashboardKpiRun)(ctx, { projectId: 1 });
        assert.deepEqual(
            run.measures.map((m) => [m.key, m.value, m.error]),
            [[key, 42, null]]
        );
        assert.deepEqual(calls, [{ databaseId: 6, queries: ['SELECT COUNT(*) FROM orders'] }]);

        // Un échec renseigne l'erreur et laisse le dernier nombre connu.
        answer = [{ value: null, error: 'Table absente.' }];
        await handlerFor(projectDashboardKpiRun)(ctx, { projectId: 1 });
        const after = await handlerFor(projectDashboard)(ctx, { projectId: 1 });
        const tile = after.tiles.find((t) => t.key === key);
        assert.equal(tile?.kpi?.lastValue, 42);
        assert.equal(tile?.kpi?.lastError, 'Table absente.');
    });

    it('dit qu’une base déliée n’est plus mesurable, sans toucher à la requête', async () => {
        const repo = fakeRepo();
        seedTwoTiers(repo);
        repo.rows.links.database.push({ project_id: 1, workspace_id: 1, item_id: 6 });
        const ctx = contextWith(repo, {
            providers: {
                [DATABASE_MEASURE_PROVIDER]: { measure: async () => [{ value: 1, error: null }] }
            }
        });
        const kpi = {
            title: 'Commandes',
            sql: 'SELECT COUNT(*) FROM orders',
            unit: '',
            comparator: null,
            threshold: null
        };
        const saved = await handlerFor(projectDashboardKpiSave)(ctx, { projectId: 1, databaseId: 6, kpi });
        const key = saved.tiles.find((t) => t.kpi !== null)?.key as string;

        repo.rows.links.database.length = 0;
        const run = await handlerFor(projectDashboardKpiRun)(ctx, { projectId: 1 });
        assert.deepEqual(
            run.measures.map((m) => [m.key, m.error]),
            [[key, 'Cette base n’est plus reliée à ce projet.']]
        );
        const after = await handlerFor(projectDashboard)(ctx, { projectId: 1 });
        assert.equal(after.tiles.find((t) => t.key === key)?.kpi?.sql, 'SELECT COUNT(*) FROM orders');
    });
});

describe('la page publique d’un projet', () => {
    const DRAFT = {
        enabled: true,
        domainId: null,
        slug: null,
        showDates: false,
        showAssignees: false,
        showSubtasks: false,
        theme: 'auto' as const,
        accent: ''
    };
    const publish = handlerFor(projectPublish);
    const get = handlerFor(projectPublicationGet);
    const eventsOf = (repo: FakeRepo) => repo.rows.events.filter((e) => e.kind === 'projects.publication');

    it('s’ouvre sous l’adresse de DevEye avec un lien tiré au hasard, fermée par défaut dans les options', async () => {
        const repo = fakeRepo();
        repo.rows.projects.push(project({ id: 1 }));
        const ctx = contextWith(repo);
        assert.deepEqual(await get(ctx, { projectId: 1 }), { publication: null, blocked: null, limit: null });

        const { publication } = await publish(ctx, { projectId: 1, publication: DRAFT });
        assert.match(publication.url, /^https:\/\/public\.deveye\.test\/projet\/[0-9a-f]{16}$/);
        assert.equal(publication.showDates, false);
        assert.equal(publication.showAssignees, false);
        assert.equal(eventsOf(repo).length, 1);

        // Fermer puis rouvrir rend le même lien ; seul « Changer le lien » le change.
        const closed = await publish(ctx, { projectId: 1, publication: { ...DRAFT, enabled: false } });
        const reopened = await publish(ctx, { projectId: 1, publication: DRAFT });
        assert.equal(closed.publication.url, publication.url);
        assert.equal(reopened.publication.url, publication.url);
        const relinked = await handlerFor(projectPublicationRelink)(ctx, { projectId: 1 });
        assert.notEqual(relinked.publication.url, publication.url);
        assert.equal(eventsOf(repo).length, 4);
    });

    it('compte les projets en ligne de tous les espaces du propriétaire, et seulement à la mise en ligne', async () => {
        const repo = fakeRepo();
        repo.rows.projects.push(project({ id: 1 }), project({ id: 2 }), project({ id: 3, workspace_id: 9 }));
        const none = contextWith(repo, { quotaLimits: { pages: 0 } });
        await assert.rejects(publish(none, { projectId: 1, publication: DRAFT }), failsWith('quota_exceeded'));
        assert.equal(repo.publication.rows.length, 0);

        repo.publication.rows.push({
            project_id: 3,
            public_ref: 'cccccccccccccccc',
            enabled: 1,
            published_at: 1,
            domain_id: null,
            slug: null,
            domain_at: null,
            show_dates: 0,
            show_assignees: 0,
            show_subtasks: 0,
            theme: 'auto',
            accent: '',
            created: 1
        });
        const one = contextWith(repo, { quotaLimits: { pages: 2 }, ownerWorkspaceIds: [1, 9] });
        await publish(one, { projectId: 1, publication: DRAFT });
        await assert.rejects(publish(one, { projectId: 2, publication: DRAFT }), failsWith('quota_exceeded'));
        // Une page déjà en ligne se règle sans repasser par l'offre.
        const tuned = await publish(one, { projectId: 1, publication: { ...DRAFT, showDates: true } });
        assert.equal(tuned.publication.showDates, true);
        assert.equal((await get(one, { projectId: 1 })).limit, 2);
        // Le stock compte les pages, pas les projets : un projet déplacé, qui les
        // laisse derrière lui, n'entre pas dans l'offre de la cible à ce titre.
        const stock = await serverEntry.quotas?.pages.list?.(repo, [1, 9]);
        assert.deepEqual(
            stock?.map((item) => item.id),
            ['public:3', 'public:1']
        );
    });

    it('refuse un projet gardé, et ne se règle pas depuis un espace qui le voit partagé', async () => {
        const repo = fakeRepo({ 1: [7] });
        repo.rows.projects.push(project({ id: 1 }), project({ id: 2, security_tier: 'guarded' }));
        const ctx = contextWith(repo, { kind: 'personal' });
        assert.equal((await get(ctx, { projectId: 2 })).blocked, 'guarded');
        await assert.rejects(publish(ctx, { projectId: 2, publication: DRAFT }), failsWith('validation'));

        const window = contextWith(repo, { workspaceId: 7, shares: { 1: 1 } });
        assert.deepEqual(await get(window, { projectId: 1 }), { publication: null, blocked: 'foreign', limit: null });
        await assert.rejects(publish(window, { projectId: 1, publication: DRAFT }), failsWith('validation'));
    });

    it('prend un domaine vérifié : le premier en tient la racine, le suivant un chemin tiré de son titre', async () => {
        const repo = fakeRepo();
        repo.rows.projects.push(
            project({ id: 1, content: body('Site web') }),
            project({ id: 2, content: body('Site web') }),
            project({ id: 3, content: body('Appli') })
        );
        const domains = [
            testDomain({ id: 5, host: 'roadmap.exemple.fr' }),
            testDomain({ id: 6, host: 'attente.exemple.fr', verified: false })
        ];
        const ctx = contextWith(repo, { domains });
        await assert.rejects(
            publish(ctx, { projectId: 1, publication: { ...DRAFT, domainId: 6 } }),
            failsWith('validation')
        );

        const first = await publish(ctx, { projectId: 1, publication: { ...DRAFT, domainId: 5 } });
        assert.equal(first.publication.url, 'https://roadmap.exemple.fr/');
        assert.equal(first.publication.atRoot, true);
        assert.equal(first.publication.slug, 'site-web');

        const second = await publish(ctx, { projectId: 2, publication: { ...DRAFT, domainId: 5 } });
        assert.equal(second.publication.url, 'https://roadmap.exemple.fr/projet/site-web-2');
        assert.equal(second.publication.atRoot, false);
        assert.equal(second.publication.rootTitle, 'Site web');

        await assert.rejects(
            publish(ctx, { projectId: 3, publication: { ...DRAFT, domainId: 5, slug: 'site-web' } }),
            failsWith('conflict')
        );
        const chosen = await publish(ctx, { projectId: 3, publication: { ...DRAFT, domainId: 5, slug: 'mobile' } });
        assert.equal(chosen.publication.url, 'https://roadmap.exemple.fr/projet/mobile');

        // Le premier ferme : le plus ancien des suivants monte à la racine.
        await publish(ctx, { projectId: 1, publication: { ...DRAFT, enabled: false, domainId: 5 } });
        const promoted = await get(ctx, { projectId: 2 });
        assert.equal(promoted.publication?.url, 'https://roadmap.exemple.fr/');
        // Rouvert, il rejoint la file par la fin plutôt que de reprendre la racine.
        const back = await publish(ctx, { projectId: 1, publication: { ...DRAFT, domainId: 5 } });
        assert.equal(back.publication.url, 'https://roadmap.exemple.fr/projet/site-web');
    });

    it('tire un chemin sans accent ni ponctuation, et le rend unique sur le domaine', () => {
        assert.equal(slugify('Refonte : Café & Crème !'), 'refonte-cafe-creme');
        assert.equal(slugify('???'), 'projet');
        assert.equal(uniqueSlug('site', new Set(['site', 'site-2'])), 'site-3');
        assert.ok(uniqueSlug('x'.repeat(48), new Set(['x'.repeat(48)])).length <= 48);
    });

    it('tombe, lien compris, quand le projet passe en confidentiel', async () => {
        const repo = fakeRepo();
        repo.rows.projects.push(project({ id: 1, content: `server:${body('Projet 1')}` }));
        const ctx = tagging(contextWith(repo, { kind: 'personal' }));
        await publish(ctx, { projectId: 1, publication: DRAFT });
        await handlerFor(projectSetSecurityTier)(ctx, { projectId: 1, securityTier: 'guarded' });
        assert.deepEqual(repo.publication.rows, []);
        assert.ok(eventsOf(repo).some((e) => e.content.includes('passé en confidentiel')));
    });
});
