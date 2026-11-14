import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { z, ZodType } from 'zod';

import {
    DATABASE_ITEMS_PROVIDER,
    GIT_ITEMS_PROVIDER,
    type DatabaseItemsProvider,
    type GitFilesResult,
    type GitHomeRepo,
    type GitItemsProvider
} from '@deveye/types/sdk';
import type { DockerInventory } from '@deveye/types';
import type { SdkDevice, SdkFeatureContext } from '@deveye/types/sdk/server';
import { createTestContext, createTestServiceDeps } from '@deveye/types/sdk/testing';

import { cveExposure, cveExposureCount, cveFindingIgnore, cveInventory } from '../../contracts/commands';
import { osvHealth } from '../matching/osv';
import type { CveAffectingRow, CveRepo, CveStateKey, CveWatchedRow } from '../repo';
import { createExposureEngine } from './engine';
import { exposureHandlers } from './handlers';
import { memoryExposureRepo } from './repo.fake';

/**
 * Un passage de la veille de bout en bout, sur un Git et un OSV de papier : un
 * dépôt lu donne ses constats, une mise à jour en résout, un dépôt neuf rouvre
 * ce qu'une décision avait ignoré, et un membre ne voit que ce qu'il peut voir.
 */

const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

const lock = (lodash: string) =>
    JSON.stringify({ lockfileVersion: 3, packages: { '': {}, 'node_modules/lodash': { version: lodash } } });

/** Un OSV de papier : un avis contre lodash 4.17.20, rien d'autre. */
async function osvFetch(url: string, init?: RequestInit): Promise<Response> {
    if (url.endsWith('/querybatch')) {
        const body = JSON.parse(String(init?.body)) as { queries: { package: { name: string }; version: string }[] };
        return json({
            results: body.queries.map((q) =>
                q.package.name === 'lodash' && q.version === '4.17.20' ? { vulns: [{ id: 'GHSA-p6mc' }] } : {}
            )
        });
    }
    return json({
        id: 'GHSA-p6mc',
        summary: 'Prototype pollution in lodash. More details follow.',
        aliases: ['CVE-2020-8203'],
        database_specific: { severity: 'HIGH' },
        affected: [{ package: { name: 'lodash', ecosystem: 'npm' }, ranges: [{ events: [{ fixed: '4.17.21' }] }] }]
    });
}

/** Aucun catalogue ne sort sur le réseau : endoflife.date en panne, deps.dev qui ne connaît rien. */
const offline = async (): Promise<Response> => new Response('', { status: 503 });
const unknown = async (): Promise<Response> => new Response('', { status: 404 });

interface FakeRepoState {
    files: Record<number, { path: string; text: string }[]>;
}

/** Un Git de papier : des dépôts dans l'espace 1, et leurs fichiers à la tête. */
function fakeGit(homes: GitHomeRepo[], state: FakeRepoState, hidden: Set<number> = new Set()): GitItemsProvider {
    const unused = async (): Promise<never> => {
        throw new Error('non attendu ici');
    };
    return {
        exists: unused,
        labelOf: unused,
        list: unused,
        openCheckout: unused,
        activity: unused,
        listHome: async () => homes,
        describe: async (id) => ({
            workspaceId: 1,
            label: `o/app${id}`,
            cloneUrl: '',
            webUrl: '',
            defaultBranch: 'main'
        }),
        authorize: async (id) => (hidden.has(id) ? { ok: false, reason: 'hidden' } : { ok: true }),
        readFiles: async (id): Promise<GitFilesResult> => ({
            status: 'ok',
            tree: `tree-${homes.find((h) => h.id === id)?.headSha}`,
            files: state.files[id] ?? [],
            truncated: false,
            skipped: []
        })
    };
}

const nginxRow: CveAffectingRow = {
    cve_id: 'CVE-2024-7347',
    vendor: 'f5',
    product: 'nginx',
    version: null,
    start_incl: '1.5.13',
    start_excl: null,
    end_incl: null,
    end_excl: '1.27.1',
    severity: 'medium',
    score: 4.7,
    summary: 'NGINX Open Source has a vulnerability in the ngx_http_mp4_module. More.',
    published: 1_723_000_000
};

/** Le catalogue en mémoire : nginx est suivi et rattrapé, le fil est à jour. */
function memoryRepo(): CveRepo & ReturnType<typeof memoryExposureRepo> {
    const state = new Map<CveStateKey, number>([['ingestedAt', Math.floor(Date.now() / 1000)]]);
    const watched: CveWatchedRow[] = [];
    const unused = async (): Promise<never> => {
        throw new Error('non attendu ici');
    };
    return {
        ...memoryExposureRepo(),
        listNews: unused,
        search: unused,
        find: unused,
        listFavorites: unused,
        upsertMany: unused,
        addFavorite: unused,
        removeFavorite: unused,
        purge: unused,
        setBackfill: unused,
        async watch(products, at) {
            for (const p of products) {
                watched.push({ ...p, requested_at: at, backfill_index: 0, backfilled_at: at });
            }
            return products.length;
        },
        listWatched: async () => watched,
        affecting: async (vendor, product) => (vendor === 'f5' && product === 'nginx' ? [nginxRow] : []),
        getState: async (key) => state.get(key) ?? null,
        setState: async (key, value) => {
            state.set(key, value);
        }
    };
}

function setup(hidden: Set<number> = new Set()) {
    const repo = memoryRepo();
    const homes: GitHomeRepo[] = [{ id: 7, workspaceId: 1, headSha: 'a1', headSeenAt: 1, paused: false }];
    const files: FakeRepoState = {
        files: {
            7: [
                { path: 'package-lock.json', text: lock('4.17.20') },
                { path: 'Dockerfile', text: 'FROM nginx:1.25.3' }
            ]
        }
    };
    const git = fakeGit(homes, files, hidden);
    const deps = createTestServiceDeps({ repo, providers: { [GIT_ITEMS_PROVIDER]: git } });
    const engine = createExposureEngine(deps, { osvFetch, eolFetch: offline, registryFetch: unknown });
    const pass = () => deps.recorded.tickers[0].tick();
    return { repo, homes, files, git, deps, engine, pass };
}

function handlerFor<C extends { command: string; input: ZodType; output: ZodType }>(contract: C) {
    const def = exposureHandlers.find((h) => h.command === contract.command);
    assert.ok(def, `handler ${contract.command} manquant`);
    return def.handler as unknown as (
        ctx: SdkFeatureContext<CveRepo>,
        input: z.output<C['input']>
    ) => Promise<z.output<C['output']>>;
}

describe('la veille de l’espace', () => {
    it('lit un dépôt, ouvre ses constats, puis résout ce qu’une mise à jour corrige', async () => {
        osvHealth.blockedUntil = 0;
        const { repo, homes, files, deps, engine, pass } = setup();
        await engine.start();
        await pass();

        assert.equal(repo.assets.length, 1);
        assert.equal(repo.assets[0].status, 'ok');
        assert.deepEqual(repo.findings.map((f) => `${f.advisory_id}:${f.state}`).sort(), [
            'CVE-2020-8203:open',
            'CVE-2024-7347:open'
        ]);
        // Premier inventaire : un récapitulatif, et seulement ce qui passe le
        // seuil (nginx, de gravité moyenne, reste sous « Élevée »).
        assert.deepEqual(
            deps.recorded.notifications.map((n) => n.subject),
            ['🐞 Premier inventaire : 1 constat dans o/app7']
        );

        // lodash monte en 4.17.21 : la tête bouge, le dépôt se relit, l'avis tombe.
        homes[0] = { ...homes[0], headSha: 'b2' };
        files.files[7] = [
            { path: 'package-lock.json', text: lock('4.17.21') },
            { path: 'Dockerfile', text: 'FROM nginx:1.25.3' }
        ];
        await pass();
        const lodash = repo.findings.find((f) => f.advisory_id === 'CVE-2020-8203');
        assert.equal(lodash?.state, 'resolved');
        assert.equal(repo.findings.find((f) => f.advisory_id === 'CVE-2024-7347')?.state, 'open');
        await engine.stop();
    });

    it('rouvre un constat ignoré qu’un dépôt neuf vient toucher, et l’annonce', async () => {
        osvHealth.blockedUntil = 0;
        const { repo, homes, files, deps, engine, pass } = setup();
        await deps.storeFor(1).put(
            'exposurePrefs',
            JSON.stringify({
                sources: { git: true, device: true, database: true, deploy: true },
                alerts: { vuln: true, eol: true, deprecated: true, outdated: false },
                threshold: 'all'
            })
        );
        await engine.start();
        await pass();
        const ctx = createTestContext({ repo, providers: { [GIT_ITEMS_PROVIDER]: setup().git }, canWrite: true });
        const nginx = repo.findings.find((f) => f.advisory_id === 'CVE-2024-7347')!;
        const ignored = await handlerFor(cveFindingIgnore)(ctx, { id: nginx.id, reason: 'pas exposé' });
        assert.equal(ignored.finding.state, 'ignored');
        assert.equal(ignored.finding.reason, 'pas exposé');

        homes.push({ id: 8, workspaceId: 1, headSha: 'c3', headSeenAt: 1, paused: false });
        files.files[8] = [{ path: 'compose.yml', text: 'services:\n  web:\n    image: nginx:1.25.3\n' }];
        await pass();
        const after = repo.findings.find((f) => f.id === nginx.id);
        assert.equal(after?.state, 'open');
        assert.equal(after?.ignored_at, null);
        // Le retour de la faille touche un dépôt déjà annoncé : une alerte à part
        // entière, en plus du récapitulatif du dépôt neuf.
        assert.deepEqual(deps.recorded.notifications.map((n) => n.subject).slice(1), [
            '🐞 CVE-2024-7347 (gravité moyenne 4.7) touche 2 éléments',
            '🐞 Premier inventaire : 1 constat dans o/app8'
        ]);
        await engine.stop();
    });

    it('compte et liste pour un membre ce qu’il peut voir, rien d’autre', async () => {
        osvHealth.blockedUntil = 0;
        const { repo, engine, pass } = setup();
        await engine.start();
        await pass();

        const open = createTestContext({ repo, providers: { [GIT_ITEMS_PROVIDER]: setup().git } });
        const counts = await handlerFor(cveExposureCount)(open, {});
        assert.deepEqual(
            { count: counts.count, high: counts.high, scanned: counts.scanned },
            { count: 2, high: 1, scanned: 1 }
        );
        const listed = await handlerFor(cveExposure)(open, { view: 'active' });
        const lodash = listed.findings.find((f) => f.advisoryId === 'CVE-2020-8203');
        assert.equal(lodash?.title, 'lodash : Prototype pollution in lodash');
        assert.deepEqual(lodash?.fixed, ['4.17.21']);
        assert.deepEqual(
            lodash?.affected.map((a) => `${a.label}:${a.version}:${a.path}`),
            ['o/app7:4.17.20:package-lock.json']
        );
        const inventory = await handlerFor(cveInventory)(open, {});
        assert.deepEqual(
            inventory.assets[0].formats.map((f) => `${f.format}:${f.count}`),
            ['package-lock.json:1', 'Dockerfile:1']
        );

        const blind = createTestContext({ repo, providers: { [GIT_ITEMS_PROVIDER]: setup(new Set([7])).git } });
        assert.equal((await handlerFor(cveExposureCount)(blind, {})).count, 0);
        assert.deepEqual((await handlerFor(cveExposure)(blind, { view: 'active' })).findings, []);
        await engine.stop();
    });
});

describe('les appareils et les bases', () => {
    it('lit un conteneur par l’agent et une base par sa version, et les confronte au catalogue', async () => {
        osvHealth.blockedUntil = 0;
        const repo = memoryRepo();
        const device = {
            id: 'd1',
            name: 'nas',
            online: true,
            status: 'active',
            ownerUserId: 1,
            workspaceId: 1,
            metricIntervalSeconds: 60,
            effectiveMetricIntervalSeconds: 60,
            report: { os: { name: 'Debian GNU/Linux', version: '12', arch: 'x86_64', cores: 4 } }
        } as unknown as SdkDevice;
        const databases = {
            listHome: async () => [
                {
                    id: 3,
                    workspaceId: 1,
                    name: 'prod',
                    engine: 'mysql' as const,
                    serverVersion: '8.0.36',
                    checkedAt: 1,
                    paused: false
                }
            ],
            authorize: async () => ({ ok: true as const })
        } as unknown as DatabaseItemsProvider;
        const deps = createTestServiceDeps({
            repo,
            devices: [device],
            dockerInventory: async () =>
                ({
                    engines: [{ engine: 'docker', reachable: true, version: '27.1.1', error: null }],
                    containers: [
                        {
                            engine: 'docker',
                            id: 'c',
                            name: 'web',
                            image: 'nginx:1.25.3',
                            state: 'running',
                            status: 'Up',
                            ports: '',
                            createdAt: 0,
                            composeProject: null,
                            composeService: null,
                            composeWorkingDir: null
                        }
                    ],
                    images: [],
                    volumes: [],
                    networks: []
                }) as unknown as DockerInventory,
            providers: { [DATABASE_ITEMS_PROVIDER]: databases }
        });
        const engine = createExposureEngine(deps, { osvFetch, eolFetch: offline, registryFetch: unknown });
        await engine.start();
        await deps.recorded.tickers[0].tick();
        await engine.stop();

        assert.deepEqual(repo.assets.map((a) => `${a.source}:${a.ref}:${a.status}`).sort(), [
            'database:3:ok',
            'device:d1:ok'
        ]);
        const nginx = repo.findings.find((f) => f.advisory_id === 'CVE-2024-7347');
        assert.ok(nginx, 'le conteneur nginx 1.25.3 trouve sa CVE');
        const device1 = repo.assets.find((a) => a.source === 'device')!;
        assert.ok(repo.links.some((l) => l.finding_id === nginx.id && l.asset_id === device1.id));
    });
});

describe('les fins de vie', () => {
    it('ouvrent un constat pour une branche que plus rien ne corrige, même à étiquette flottante', async () => {
        osvHealth.blockedUntil = 0;
        const { repo, files, deps } = setup();
        files.files[7] = [{ path: 'Dockerfile', text: 'FROM postgres:13-alpine' }];
        const dump = {
            result: [
                {
                    name: 'postgresql',
                    label: 'PostgreSQL',
                    aliases: [],
                    identifiers: [],
                    releases: [
                        {
                            name: '16',
                            isEol: false,
                            eolFrom: '2028-11-09',
                            isMaintained: true,
                            latest: { name: '16.4' }
                        },
                        { name: '13', isEol: true, eolFrom: '2025-11-13', isMaintained: false, latest: null }
                    ]
                }
            ]
        };
        const engine = createExposureEngine(deps, {
            osvFetch,
            eolFetch: async () => new Response(JSON.stringify(dump)),
            registryFetch: unknown
        });
        await engine.start();
        await deps.recorded.tickers[0].tick();
        await engine.stop();

        const eol = repo.findings.find((f) => f.kind === 'eol');
        assert.ok(eol, 'PostgreSQL 13 est en fin de vie');
        assert.equal(eol.severity, 'high');
        assert.equal(
            repo.findings.filter((f) => f.kind === 'vuln').length,
            0,
            'une branche flottante ne se compare pas aux failles'
        );
    });
});
