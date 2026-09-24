import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { Headers, Response } from 'undici';

import { setSafeFetchTransportForTest } from '@/Services/netFetch';

import { GithubProvider, parseWorkflowId, stepsOf, toRemote } from './github';
import { ProviderError, type ProviderAccess, type ProviderTarget } from './types';

/**
 * L'adaptateur GitHub Actions sur un réseau simulé : ce qu'il demande à l'API,
 * et comment il ramène ses réponses aux quatre états du module.
 */

const ACCESS: ProviderAccess = { credentialId: 1, baseUrl: null, secret: 'ghp_x' };
const TARGET: ProviderTarget = { kind: 'workflow', externalId: 'OxyFoo/site#42', ref: 'main' };

type Reply = { status: number; body?: unknown; headers?: Record<string, string> };

/** Répond selon le chemin demandé, et garde chaque appel. */
function github(routes: Record<string, Reply | ((headers: Headers) => Reply)>) {
    const calls: { method: string; path: string; headers: Headers; body: unknown }[] = [];
    setSafeFetchTransportForTest(async (url, init) => {
        const headers = new Headers(init.headers);
        const { pathname, search } = new URL(url);
        const path = `${pathname}${search}`;
        calls.push({
            method: init.method ?? 'GET',
            path,
            headers,
            body: init.body ? JSON.parse(String(init.body)) : null
        });
        const route = routes[path] ?? routes[pathname];
        const reply =
            typeof route === 'function' ? route(headers) : (route ?? { status: 404, body: { message: 'Not Found' } });
        const payload =
            reply.body === undefined ? null : typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body);
        return new Response(payload, {
            status: reply.status,
            headers: { 'content-type': 'application/json', ...reply.headers }
        });
    });
    return calls;
}

afterEach(() => setSafeFetchTransportForTest(null));

const run = (over: Record<string, unknown> = {}) => ({
    id: 7,
    name: 'Déployer',
    display_title: 'feat: nouvelle page',
    status: 'completed',
    conclusion: 'success',
    head_branch: 'main',
    html_url: 'https://github.com/OxyFoo/site/actions/runs/7',
    run_started_at: '2026-09-24T10:00:00Z',
    created_at: '2026-09-24T09:59:50Z',
    updated_at: '2026-09-24T10:02:00Z',
    ...over
});

describe('github : les états', () => {
    it('ramène statut et conclusion aux quatre états, avec la raison d’un échec', () => {
        assert.equal(toRemote(run()).status, 'success');
        assert.equal(toRemote(run({ status: 'in_progress', conclusion: null })).status, 'running');
        assert.equal(toRemote(run({ status: 'waiting', conclusion: null })).status, 'queued');
        const cancelled = toRemote(run({ conclusion: 'cancelled' }));
        assert.equal(cancelled.status, 'failed');
        assert.equal(cancelled.description, 'Exécution annulée.');
    });

    it('ne donne une fin qu’à une exécution conclue', () => {
        assert.equal(toRemote(run()).finishedAt, Date.parse('2026-09-24T10:02:00Z') / 1000);
        assert.equal(toRemote(run({ status: 'in_progress', conclusion: null })).finishedAt, null);
    });

    it('lit le dépôt et le workflow d’une cible, et refuse une forme illisible', () => {
        assert.deepEqual(parseWorkflowId('OxyFoo/site#42'), { repo: 'OxyFoo/site', workflowId: '42' });
        assert.throws(() => parseWorkflowId('OxyFoo/site'), ProviderError);
    });
});

describe('github : l’historique', () => {
    it('filtre sur la branche de la cible, et reprend la réponse connue sur un 304', async () => {
        const path = '/repos/OxyFoo/site/actions/workflows/42/runs?per_page=20&branch=main';
        const calls = github({
            [path]: (headers) =>
                headers.get('if-none-match') === '"v1"'
                    ? { status: 304 }
                    : { status: 200, body: { workflow_runs: [run()] }, headers: { etag: '"v1"' } }
        });
        const provider = new GithubProvider();
        const first = await provider.history(ACCESS, TARGET);
        const again = await provider.history(ACCESS, TARGET);
        assert.equal(calls.length, 2);
        assert.equal(calls[0].headers.get('authorization'), 'Bearer ghp_x');
        assert.deepEqual(again, first);
        assert.equal(first[0].externalId, '7');
    });

    it('dit quand revenir quand GitHub limite le débit', async () => {
        github({
            '/repos/OxyFoo/site/actions/workflows/42/runs': {
                status: 403,
                body: { message: 'API rate limit exceeded' },
                headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '4102444800' }
            }
        });
        await assert.rejects(new GithubProvider().history(ACCESS, TARGET), (e: unknown) => {
            assert.ok(e instanceof ProviderError);
            assert.equal(e.retryAt, 4102444800);
            return true;
        });
    });

    it('distingue un droit manquant d’une limite de débit', async () => {
        github({
            '/repos/OxyFoo/site/actions/workflows/42/runs': {
                status: 403,
                body: { message: 'Resource not accessible' }
            }
        });
        await assert.rejects(new GithubProvider().history(ACCESS, TARGET), (e: unknown) => {
            assert.ok(e instanceof ProviderError);
            assert.equal(e.retryAt, null);
            assert.match(e.message, /Actions en lecture et écriture/);
            return true;
        });
    });
});

describe('github : le déclenchement', () => {
    it('lance le workflow sur la branche de la cible', async () => {
        const calls = github({ '/repos/OxyFoo/site/actions/workflows/42/dispatches': { status: 204 } });
        await new GithubProvider().trigger(ACCESS, TARGET);
        assert.equal(calls[0].method, 'POST');
        assert.deepEqual(calls[0].body, { ref: 'main' });
    });

    it('prend la branche par défaut du dépôt quand la cible n’en a pas', async () => {
        const calls = github({
            '/repos/OxyFoo/site': { status: 200, body: { full_name: 'OxyFoo/site', default_branch: 'prod' } },
            '/repos/OxyFoo/site/actions/workflows/42/dispatches': { status: 204 }
        });
        await new GithubProvider().trigger(ACCESS, { ...TARGET, ref: null });
        assert.deepEqual(calls.at(-1)?.body, { ref: 'prod' });
    });

    it('explique un workflow qui ne se lance pas à la main', async () => {
        github({
            '/repos/OxyFoo/site/actions/workflows/42/dispatches': {
                status: 422,
                body: { message: "Workflow does not have 'workflow_dispatch' trigger" }
            }
        });
        await assert.rejects(new GithubProvider().trigger(ACCESS, TARGET), /ajoutez `workflow_dispatch`/);
    });
});

describe('github : le catalogue', () => {
    it('propose les workflows actifs des dépôts, et tait un dépôt dont les Actions sont refusées', async () => {
        github({
            '/user/repos': {
                status: 200,
                body: [
                    { full_name: 'OxyFoo/site', default_branch: 'main' },
                    { full_name: 'OxyFoo/prive', default_branch: 'main' },
                    { full_name: 'OxyFoo/vieux', default_branch: 'main', archived: true }
                ]
            },
            '/repos/OxyFoo/site/actions/workflows': {
                status: 200,
                body: {
                    workflows: [
                        { id: 42, name: 'Déployer', path: '.github/workflows/deploy.yml', state: 'active' },
                        { id: 43, name: 'Ancien', path: '.github/workflows/old.yml', state: 'disabled_manually' }
                    ]
                }
            },
            '/repos/OxyFoo/prive/actions/workflows': { status: 403, body: { message: 'Resource not accessible' } }
        });
        assert.deepEqual(await new GithubProvider().candidates(ACCESS), [
            {
                kind: 'workflow',
                externalId: 'OxyFoo/site#42',
                name: 'Déployer',
                path: 'OxyFoo/site · deploy.yml',
                ref: 'main'
            }
        ]);
    });
});

describe('github : les étapes et le journal', () => {
    it('montre les étapes faites et en cours, et résume celles à venir', () => {
        const text = stepsOf([
            {
                id: 1,
                name: 'build',
                status: 'in_progress',
                conclusion: null,
                steps: [
                    { name: 'Checkout', status: 'completed', conclusion: 'success' },
                    { name: 'Build', status: 'in_progress', conclusion: null },
                    { name: 'Push', status: 'queued', conclusion: null },
                    { name: 'Deploy', status: 'queued', conclusion: null }
                ]
            }
        ]);
        assert.equal(text, '▶ build\n  ✓ Checkout\n  ▶ Build\n  · 2 étapes à venir');
    });

    it('rassemble le journal de chaque job, sans les horodatages de GitHub', async () => {
        const calls = github({
            '/repos/OxyFoo/site/actions/runs/7/jobs': {
                status: 200,
                body: { jobs: [{ id: 9, name: 'build', status: 'completed', conclusion: 'success', steps: [] }] }
            },
            '/repos/OxyFoo/site/actions/jobs/9/logs': {
                status: 302,
                headers: { location: 'https://pipelines.actions.example.net/logs/9.txt' }
            },
            '/logs/9.txt': {
                status: 200,
                body: '2026-09-24T10:00:01.1234567Z npm ci\n2026-09-24T10:00:09.0000000Z fini'
            }
        });
        const provider = new GithubProvider();
        const log = await provider.fullLog(ACCESS, TARGET, toRemote(run()));
        assert.equal(log, '=== build ===\nnpm ci\nfini');
        // Le jeton ne suit pas la redirection vers le stockage des journaux.
        assert.equal(calls.at(-1)?.headers.get('authorization'), null);
    });
});
