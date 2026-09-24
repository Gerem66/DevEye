import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { z, ZodType } from 'zod';

import { FeatureError, type SdkFeatureContext } from '@deveye/types/sdk/server';
import { createTestContext, testDomain } from '@deveye/types/sdk/testing';

import { uptimePageAdd, uptimePageList, uptimePageRemove, uptimePageUpdate } from '../contracts/commands';
import type { UptimePageRow, UptimePageServiceRow, UptimeServiceRow } from '../contracts/domain';
import { pageHandlers } from './pages';
import type { UptimeRepo } from './repo';
import type { UptimePagesRepo, UptimeStatusRepo } from './repoPages';

/**
 * Les pages de statut côté membres : le quota de l'offre du propriétaire, une
 * page qui ne montre que les services de son espace, un domaine vérifié de
 * l'espace que nulle autre page ne sert, et ce qu'une restriction de rôle
 * cache qui ne se retire pas en réécrivant la liste.
 */

function handlerFor<C extends { command: string; input: ZodType; output: ZodType }>(contract: C) {
    const def = pageHandlers.find((h) => h.command === contract.command);
    assert.ok(def, `handler ${contract.command} manquant`);
    return def.handler as (
        ctx: SdkFeatureContext<UptimeRepo>,
        input: z.output<C['input']>
    ) => Promise<z.input<C['output']>>;
}

const add = handlerFor(uptimePageAdd);
const update = handlerFor(uptimePageUpdate);
const list = handlerFor(uptimePageList);
const remove = handlerFor(uptimePageRemove);

function service(id: number, workspaceId: number): UptimeServiceRow {
    return {
        id,
        user_id: 1,
        workspace_id: workspaceId,
        content: JSON.stringify({ name: `Service ${id}`, url: `https://exemple.fr/${id}`, keyword: null }),
        method: 'GET',
        expected_status: null,
        interval_seconds: 60,
        timeout_seconds: 10,
        failure_threshold: 2,
        retention_days: null,
        enabled: 1,
        sort_order: id,
        status: 'up',
        consecutive_failures: 0,
        last_checked_at: null,
        last_response_ms: null,
        last_http_status: null,
        last_error: null,
        created: 1
    };
}

interface FakeRepo extends UptimeRepo {
    pageRows: UptimePageRow[];
    entryRows: UptimePageServiceRow[];
}

/** Un dépôt en mémoire : les services d'un côté, les pages et leurs lignes de l'autre. */
function fakeRepo(services: UptimeServiceRow[]): FakeRepo {
    let seq = 0;
    const pageRows: UptimePageRow[] = [];
    let entryRows: UptimePageServiceRow[] = [];
    const pages: UptimePagesRepo = {
        listByWorkspace: async (ws) => pageRows.filter((p) => p.workspace_id === ws),
        entriesOf: async (ids) =>
            entryRows.filter((e) => ids.includes(e.page_id)).sort((a, b) => a.sort_order - b.sort_order),
        find: async (id, ws) => pageRows.find((p) => p.id === id && p.workspace_id === ws) ?? null,
        findByRef: async (ref) => pageRows.find((p) => p.public_ref === ref) ?? null,
        findByDomain: async (domainId) => pageRows.find((p) => p.domain_id === domainId) ?? null,
        countInWorkspaces: async (ids) => pageRows.filter((p) => ids.includes(p.workspace_id)).length,
        async create({ workspaceId, publicRef, ...config }) {
            const row: UptimePageRow = {
                id: ++seq,
                workspace_id: workspaceId,
                public_ref: publicRef,
                content: config.content,
                domain_id: config.domainId,
                theme: config.theme,
                show_errors: config.showErrors ? 1 : 0,
                show_latency: config.showLatency ? 1 : 0,
                enabled: config.enabled ? 1 : 0,
                created: 1
            };
            pageRows.push(row);
            return row;
        },
        async update(id, ws, config) {
            const row = pageRows.find((p) => p.id === id && p.workspace_id === ws);
            if (!row) return null;
            Object.assign(row, {
                content: config.content,
                domain_id: config.domainId,
                theme: config.theme,
                show_errors: config.showErrors ? 1 : 0,
                show_latency: config.showLatency ? 1 : 0,
                enabled: config.enabled ? 1 : 0
            });
            return row;
        },
        async setEntries(pageId, entries) {
            entryRows = [
                ...entryRows.filter((e) => e.page_id !== pageId),
                ...entries.map((e, rank) => ({
                    page_id: pageId,
                    service_id: e.serviceId,
                    sort_order: rank,
                    label: e.label
                }))
            ];
        },
        async delete(id, ws) {
            const i = pageRows.findIndex((p) => p.id === id && p.workspace_id === ws);
            if (i === -1) return false;
            pageRows.splice(i, 1);
            entryRows = entryRows.filter((e) => e.page_id !== id);
            return true;
        },
        domainUse: async () => new Map(),
        clearDomain: async () => undefined
    };
    const repo = {
        services: {
            listByWorkspace: async (ws: number) => services.filter((s) => s.workspace_id === ws)
        },
        history: {},
        pages,
        status: {} as UptimeStatusRepo,
        pageRows,
        get entryRows() {
            return entryRows;
        }
    };
    return repo as unknown as FakeRepo;
}

const draft = (over: Partial<z.output<typeof uptimePageAdd.input>['page']> = {}) => ({
    title: 'État de nos services',
    description: '',
    services: [
        { id: 1, label: 'API publique' },
        { id: 2, label: null }
    ],
    domainId: null,
    theme: 'auto' as const,
    showErrors: false,
    showLatency: false,
    enabled: true,
    ...over
});

const code = (expected: string) => (err: unknown) => err instanceof FeatureError && err.code === expected;

describe('uptime.pageAdd', () => {
    it('crée la page sous l’adresse de DevEye, ses services dans l’ordre donné', async () => {
        const repo = fakeRepo([service(1, 1), service(2, 1)]);
        const ctx = createTestContext({ repo });
        const { page } = await add(ctx, { page: draft() });
        assert.match(page.url, /^https:\/\/public\.deveye\.test\/statut\/[0-9a-f]{16}$/);
        assert.deepEqual(page.services, [
            { id: 1, label: 'API publique' },
            { id: 2, label: null }
        ]);
        assert.equal(page.title, 'État de nos services');
        assert.equal(ctx.recorded.audits.at(-1)?.action, 'uptime.pageAdd');
    });

    it('suit l’offre du propriétaire : 0 refuse, et le compte porte sur tous ses espaces', async () => {
        const repo = fakeRepo([service(1, 1), service(2, 1)]);
        await assert.rejects(
            add(createTestContext({ repo, quotaLimits: { pages: 0 } }), { page: draft() }),
            code('quota_exceeded')
        );

        // Une page déjà créée dans un autre espace du même propriétaire compte.
        await add(createTestContext({ repo, workspaceId: 1 }), { page: draft() });
        repo.pageRows[0].workspace_id = 9;
        const limited = createTestContext({ repo, quotaLimits: { pages: 1 }, ownerWorkspaceIds: [1, 9] });
        await assert.rejects(add(limited, { page: draft() }), code('quota_exceeded'));
        const room = createTestContext({ repo, quotaLimits: { pages: 2 }, ownerWorkspaceIds: [1, 9] });
        await add(room, { page: draft() });
        assert.equal(repo.pageRows.length, 2);
    });

    it('refuse un service d’un autre espace, même projeté ici', async () => {
        const repo = fakeRepo([service(1, 1), service(2, 42)]);
        await assert.rejects(
            add(createTestContext({ repo, shares: { 2: 42 } }), { page: draft() }),
            code('validation')
        );
        assert.equal(repo.pageRows.length, 0);
    });

    it('refuse un service que le rôle de l’appelant masque', async () => {
        const repo = fakeRepo([service(1, 1), service(2, 1)]);
        await assert.rejects(
            add(createTestContext({ repo, itemRestrictions: { 2: 'none' } }), { page: draft() }),
            code('forbidden')
        );
    });

    it('n’accepte qu’un domaine vérifié de l’espace, et en donne la racine', async () => {
        const repo = fakeRepo([service(1, 1), service(2, 1)]);
        const domains = [
            testDomain({ id: 5, host: 'statut.exemple.fr', workspaceId: 1 }),
            testDomain({ id: 6, host: 'attente.exemple.fr', workspaceId: 1, verified: false, verifiedAt: null }),
            testDomain({ id: 7, host: 'statut.autre.fr', workspaceId: 42 })
        ];
        const ctx = createTestContext({ repo, domains });
        await assert.rejects(add(ctx, { page: draft({ domainId: 7 }) }), code('not_found'));
        await assert.rejects(add(ctx, { page: draft({ domainId: 6 }) }), code('validation'));
        const { page } = await add(ctx, { page: draft({ domainId: 5 }) });
        assert.equal(page.url, 'https://statut.exemple.fr/');
        // Un domaine ne sert qu'une page.
        await assert.rejects(add(ctx, { page: draft({ domainId: 5 }) }), code('conflict'));
    });
});

describe('uptime.pageUpdate', () => {
    it('garde le domaine de la page même retombé en attente, avec l’adresse de DevEye pour lien', async () => {
        const repo = fakeRepo([service(1, 1), service(2, 1)]);
        const domain = testDomain({ id: 5, host: 'statut.exemple.fr', workspaceId: 1 });
        const { page } = await add(createTestContext({ repo, domains: [domain] }), { page: draft({ domainId: 5 }) });
        const dropped = createTestContext({ repo, domains: [{ ...domain, verified: false }] });
        const { page: kept } = await update(dropped, { id: page.id, page: draft({ domainId: 5, title: 'Nouveau' }) });
        assert.equal(kept.domainId, 5);
        assert.match(kept.url, /^https:\/\/public\.deveye\.test\/statut\//);
    });

    it('laisse en place les services que l’appelant ne voit pas', async () => {
        const repo = fakeRepo([service(1, 1), service(2, 1), service(3, 1)]);
        const { page } = await add(createTestContext({ repo }), {
            page: draft({
                services: [
                    { id: 1, label: null },
                    { id: 3, label: 'Secret' }
                ]
            })
        });
        const member = createTestContext({ repo, itemRestrictions: { 3: 'none' } });

        const listed = await list(member, {});
        assert.deepEqual(listed.pages[0].services, [{ id: 1, label: null }]);

        await update(member, { id: page.id, page: draft({ services: [{ id: 2, label: null }] }) });
        assert.deepEqual(
            repo.entryRows.map((e) => e.service_id),
            [2, 3]
        );
        assert.equal(repo.entryRows.find((e) => e.service_id === 3)?.label, 'Secret');
    });

    it('ne touche pas la page d’un autre espace', async () => {
        const repo = fakeRepo([service(1, 1), service(2, 1)]);
        const { page } = await add(createTestContext({ repo }), { page: draft() });
        await assert.rejects(
            update(createTestContext({ repo, workspaceId: 2 }), { id: page.id, page: draft() }),
            code('not_found')
        );
        await assert.rejects(remove(createTestContext({ repo, workspaceId: 2 }), { id: page.id }), code('not_found'));
    });
});

describe('uptime.pageList / pageRemove', () => {
    it('rend la limite de l’offre, 0 compris, et retire une page', async () => {
        const repo = fakeRepo([service(1, 1), service(2, 1)]);
        assert.equal((await list(createTestContext({ repo, quotaLimits: { pages: 0 } }), {})).limit, 0);
        assert.equal((await list(createTestContext({ repo }), {})).limit, null);

        const ctx = createTestContext({ repo });
        const { page } = await add(ctx, { page: draft() });
        await remove(ctx, { id: page.id });
        assert.deepEqual((await list(ctx, {})).pages, []);
    });
});
