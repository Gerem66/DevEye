import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { z, ZodType } from 'zod';

import {
    projectAdd,
    projectArchive,
    projectAudienceLink,
    projectBoard,
    projectCardAdd,
    projectCardArchive,
    projectCardMove,
    projectCardSetMilestone,
    projectColumnAdd,
    projectColumnRemove,
    projectCommands,
    projectCount,
    projectDatabaseLink,
    projectDepAdd,
    projectDeployLink,
    projectEventList,
    projectGet,
    projectLinkCounts,
    projectList,
    projectMessageEdit,
    projectMessageList,
    projectMessageSend,
    projectMilestoneSetReached,
    projectMyTasks,
    projectReorder,
    projectRepoLink,
    projectSetSecurityTier,
    projectSetVersion,
    projectUpdate,
    projectUptimeLink,
    projectUptimeUnlink
} from '../contracts/commands';
import { PROJECT_MAX_COLUMNS } from '../contracts/domain';
import type {
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
    DEPLOY_ITEMS_PROVIDER,
    GIT_ITEMS_PROVIDER,
    UPTIME_ITEMS_PROVIDER
} from '@deveye/types/sdk';
import { FeatureError, type SdkCipher, type SdkFeatureContext } from '@deveye/types/sdk/server';
import { createTestContext, type TestContext, type TestContextOverrides } from '@deveye/types/sdk/testing';

import { projectsHandlers } from './handlers';
import type { ProjectsRepo } from './repo';

/**
 * Les handlers du module, sur le harnais du SDK.
 *
 * Ce qui mérite d'être tenu, c'est ce qui ne lève nulle part quand ça se
 * dérègle : les **deux étages par projet** (un projet gardé s'écrit sous le
 * codec gardé, n'existe pas dans un espace partagé, et sa conversion
 * re-chiffre tout son arbre en retirant ses liaisons), le **verrou** (le
 * portefeuille et mes tâches masquent au lieu de lever, une lecture de détail
 * et toute écriture sur un projet gardé répondent `locked` à une session
 * scellée, sauf ce qui ne touche aucun corps chiffré), les **sujets** (chaque
 * écriture déclare `mutates`, la discussion bat `projectsChat` et pas
 * `projects`, une liaison bat aussi la feature visée : le filet de démarrage
 * de l'app ne voit aucune commande de ce module), les **liaisons** par les
 * contrats d'éléments (absents = refus propre, jamais une ligne écrite), les
 * gardes de forme (une carte ne change pas de projet, une dépendance ne forme
 * pas de cycle, une colonne pleine ne se retire pas, un assigné ou une
 * mention est un membre), et la frise posée par les mutations elles-mêmes.
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
 * Un dépôt en mémoire, même contrat que le vrai, sur des tableaux que les
 * tests lisent après coup. Les listes d'identifiants liés rendent l'ordre
 * d'insertion : la jointure d'ordre du vrai dépôt n'a rien à prouver ici.
 */
function fakeRepo(): FakeRepo {
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
        links: { uptime: [], database: [], deploy: [], repo: [], site: [] }
    };
    // `locate` rend la ligne vivante, pour les mutations ; `find` en rend une
    // copie, comme une base rend une ligne fraîche : un handler qui relit une
    // ligne après l'avoir écrite ne doit pas voir sa lecture d'avant changer.
    const locate = <T extends { id: number; workspace_id: number }>(list: T[], id: number, ws: number): T | null =>
        list.find((r) => r.id === id && r.workspace_id === ws) ?? null;
    const find = <T extends { id: number; workspace_id: number }>(list: T[], id: number, ws: number): T | null => {
        const row = locate(list, id, ws);
        return row ? { ...row } : null;
    };
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
        { table: 'project_events', list: () => rows.events }
    ];
    return {
        rows,
        projects: {
            listByWorkspace: async (ws, archived) =>
                rows.projects
                    .filter((p) => p.workspace_id === ws && (p.archived_at !== null) === archived)
                    .sort((a, b) => a.sort_order - b.sort_order || a.id - b.id),
            countActiveByWorkspace: async (ws) =>
                rows.projects.filter((p) => p.workspace_id === ws && p.archived_at === null).length,
            findById: async (id, ws) => find(rows.projects, id, ws),
            async create(input) {
                const row = project({
                    id: ++seq,
                    workspace_id: input.workspaceId,
                    user_id: input.userId,
                    status: input.status,
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
            statsByWorkspace: async (ws, userId, now) =>
                rows.projects
                    .filter((p) => p.workspace_id === ws && p.archived_at === null)
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
            findColumn: async (id, ws) => find(rows.columns, id, ws),
            async createColumn(input) {
                const row = column({
                    id: ++seq,
                    project_id: input.projectId,
                    workspace_id: input.workspaceId,
                    sort_order: rows.columns.filter((c) => c.project_id === input.projectId).length,
                    counts_as_done: input.countsAsDone ? 1 : 0,
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
            countCardsInColumn: async (id, ws) =>
                rows.cards.filter((c) => c.column_id === id && c.workspace_id === ws).length,
            async deleteColumn(id, ws) {
                const before = rows.columns.length;
                rows.columns = rows.columns.filter((c) => !(c.id === id && c.workspace_id === ws));
                return rows.columns.length < before;
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
            findCard: async (id, ws) => find(rows.cards, id, ws),
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
            async restoreCard(id, ws) {
                const row = locate(rows.cards, id, ws);
                if (row) row.archived_at = null;
                return row !== null;
            },
            unreadByProject: async (projectId, ws, userId) =>
                rows.cards
                    .filter((c) => c.project_id === projectId && c.workspace_id === ws && c.archived_at === null)
                    .map((c) => ({ card_id: c.id, unread: unreadOf(c, userId) })),
            listAssignedTo: async (ws, userId) =>
                rows.cards.filter(
                    (c) =>
                        c.workspace_id === ws &&
                        c.assignee_user_id === userId &&
                        c.archived_at === null &&
                        rows.projects.find((p) => p.id === c.project_id)?.archived_at === null
                )
        },
        chat: {
            listByCard: async (cardId, ws, before, limit) =>
                rows.messages
                    .filter((m) => m.card_id === cardId && m.workspace_id === ws && (before === null || m.id < before))
                    .sort((a, b) => b.id - a.id)
                    .slice(0, limit),
            findById: async (id, ws) => find(rows.messages, id, ws),
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
            findMilestone: async (id, ws) => find(rows.milestones, id, ws),
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
            listDatabaseIds: ids('database'),
            linkDatabase: link('database'),
            unlinkDatabase: unlink('database'),
            unlinkAllDatabases: async (projectId, ws) => {
                await unlinkAll('database')(projectId, ws);
            },
            listDatabaseUsage: usage('database', true),
            countDatabaseLinks: counts('database'),
            listDeployTargetIds: ids('deploy'),
            linkDeployTarget: link('deploy'),
            unlinkDeployTarget: unlink('deploy'),
            unlinkAllDeployTargets: unlinkAll('deploy'),
            listDeployUsage: usage('deploy', true),
            countDeployLinks: counts('deploy'),
            listRepoIds: ids('repo'),
            linkRepo: link('repo'),
            unlinkRepo: unlink('repo'),
            unlinkAllRepos: unlinkAll('repo'),
            listRepoUsage: usage('repo', true),
            countRepoLinks: counts('repo'),
            listSiteIds: ids('site'),
            linkSite: link('site'),
            unlinkSite: unlink('site'),
            unlinkAllSites: async (projectId, ws) => {
                await unlinkAll('site')(projectId, ws);
            },
            listSiteUsage: usage('site', false),
            countSiteLinks: counts('site')
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
        }
    };
}

/**
 * Un codec qui étiquette son étage : le harnais chiffre à l'identité, ce qui
 * ne dit pas SOUS QUEL codec une ligne a été écrite. Posé sur `ctx.cipher`, il
 * rend visible le choix du palier, qui est toute la question ici.
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
            // Une lecture est personnelle : la diffuser ferait re-solliciter
            // tout l'espace parce qu'une seule personne a ouvert une carte.
            'projects.markRead',
            'projects.plan',
            'projects.eventList',
            'projects.repoList',
            'projects.deployList',
            'projects.myTasks',
            'projects.linkCounts',
            'projects.uptimeList',
            'projects.databaseList',
            'projects.audienceList'
        ]);
        for (const h of projectsHandlers) {
            if (reads.has(h.command)) {
                assert.equal(h.mutates, undefined, `${h.command} lit, et ne doit rien battre`);
                assert.equal(h.access?.level, undefined, `${h.command} lit, au niveau par défaut`);
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
        assert.equal(topicsOf('projects.cardAdd'), true);
        // Aucune liste ne nomme un sujet que le boot refuserait : les nôtres
        // (l'id, le secondaire du manifest) et ceux des quatre features reliées.
        const known = new Set(['projects', 'projectsChat', 'git', 'deploy', 'database', 'audience']);
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
        // En `github_release`, le numéro appartient au module Git : celui
        // demandé est ignoré, celui en place est gardé.
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

        // Chaque cellule de l'arbre est relue sous le codec gardé, et rien
        // ne reste sous l'ancien.
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

        // Les liaisons aux objets d'espace tombent ; les services surveillés,
        // que le module ne relie pas par un contrat d'espace ouvert, restent.
        assert.deepEqual(
            [repo.rows.links.repo, repo.rows.links.database, repo.rows.links.site, repo.rows.links.deploy].map(
                (l) => l.length
            ),
            [0, 0, 0, 0]
        );
        assert.equal(repo.rows.links.uptime.length, 1);

        // Les événements de déliaison sont écrits sous l'ANCIEN étage, puis
        // convertis avec le reste ; la conversion elle-même sous le nouveau.
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
            handlerFor(projectColumnAdd)(contextWith(repo), { projectId: 1, name: 'Une de trop' }),
            failsWith('validation')
        );
    });

    it('une colonne ne se retire que vide, archivées comprises', async () => {
        const repo = fakeRepo();
        seedTwoTiers(repo);
        repo.rows.cards[0].archived_at = 9;
        await assert.rejects(
            handlerFor(projectColumnRemove)(contextWith(repo), { columnId: 10 }),
            failsWith('conflict')
        );
        repo.rows.columns.push(column({ id: 12, project_id: 1 }));
        assert.deepEqual(await handlerFor(projectColumnRemove)(contextWith(repo), { columnId: 12 }), { columnId: 12 });
        assert.ok(!repo.rows.columns.some((c) => c.id === 12));
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

    it('les compteurs d’onglets lisent les liaisons en clair, déploiement et services confondus', async () => {
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
        assert.deepEqual(counted.counts, { git: 1, database: 2, audience: 0, deploy: 2 });
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
