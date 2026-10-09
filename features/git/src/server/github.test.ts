import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import {
    authorRef,
    fetchDeployments,
    fetchPullRequests,
    fetchRepoInfo,
    fetchWorkflowRuns,
    GitHubError,
    listTokenOwners,
    nameRef
} from './github';
import { summarizeActivity } from './index';

/** Les fonctions pures de l'adaptateur GitHub, et ses décodeurs. */

const realFetch = globalThis.fetch;

/** Un `fetch` qui rend toujours la même réponse, et retient ce qu'on lui a demandé. */
function answerWith(status: number, body: unknown, headers: Record<string, string> = {}) {
    const asked: { url: string; headers: Record<string, string> }[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        asked.push({ url: String(input), headers: { ...((init?.headers as Record<string, string>) ?? {}) } });
        return new Response(status === 304 ? null : JSON.stringify(body), { status, headers });
    }) as typeof fetch;
    return asked;
}

afterEach(() => {
    globalThis.fetch = realFetch;
});

describe('les condensés', () => {
    it('authorRef normalise la casse et les espaces, nameRef non', () => {
        assert.equal(authorRef('  Gerem@Example.com '), authorRef('gerem@example.com'));
        assert.notEqual(authorRef('gerem@example.com'), authorRef('autre@example.com'));
        assert.equal(authorRef('x').length, 16);
        assert.notEqual(nameRef('Main'), nameRef('main'));
        assert.equal(nameRef('feature/x'), nameRef('feature/x'));
    });
});

describe('fetchPullRequests', () => {
    it('sépare fusionnée, fermée, brouillon et ouverte sur la seule preuve fiable', async () => {
        answerWith(200, [
            { number: 1, state: 'closed', merged_at: '2026-08-01T10:00:00Z', closed_at: '2026-08-01T10:00:00Z' },
            { number: 2, state: 'closed', merged_at: null, closed_at: '2026-08-02T10:00:00Z' },
            { number: 3, state: 'open', draft: true, user: { login: 'gerem' }, head: { ref: 'wip' } },
            { number: 4, state: 'open', created_at: '2026-08-04T10:00:00Z' }
        ]);
        const out = await fetchPullRequests('o', 'r', 'tok');
        assert.deepEqual(
            out.data?.map((p) => [p.number, p.state, p.mergedAt !== null, p.closedAt !== null]),
            [
                [1, 'merged', true, true],
                [2, 'closed', false, true],
                [3, 'draft', false, false],
                [4, 'open', false, false]
            ]
        );
        assert.equal(out.data?.[2].authorLogin, 'gerem');
        assert.equal(out.data?.[2].headBranch, 'wip');
        // `updatedAt` retombe sur `createdAt` quand le fournisseur ne le dit pas.
        assert.equal(out.data?.[3].updatedAt, out.data?.[3].createdAt);
    });
});

describe('les ETags', () => {
    it('renvoie l’ETag connu et lit un 304 comme « rien n’a changé »', async () => {
        const asked = answerWith(304, null);
        const out = await fetchRepoInfo('o', 'r', 'tok', 'W/"abc"');
        assert.deepEqual(out, { data: null, etag: 'W/"abc"' });
        assert.equal(asked[0].headers['if-none-match'], 'W/"abc"');
    });

    it('reconnaît un quota épuisé au compteur, jamais au seul code', async () => {
        answerWith(403, {}, { 'x-ratelimit-remaining': '0' });
        await assert.rejects(fetchRepoInfo('o', 'r', 'tok'), (e: unknown) => e instanceof GitHubError && e.rateLimited);
        answerWith(403, {}, { 'x-ratelimit-remaining': '12' });
        await assert.rejects(
            fetchRepoInfo('o', 'r', 'tok'),
            (e: unknown) => e instanceof GitHubError && !e.rateLimited
        );
    });
});

describe('listTokenOwners', () => {
    /** Un `fetch` qui répond selon le chemin ; un chemin absent répond 403. */
    function route(answers: Record<string, unknown>) {
        globalThis.fetch = (async (input: string | URL | Request) => {
            const path = new URL(String(input)).pathname;
            return path in answers
                ? new Response(JSON.stringify(answers[path]), { status: 200 })
                : new Response('{}', { status: 403 });
        }) as typeof fetch;
    }

    it('met le compte du jeton en tête, puis les organisations des deux sources, sans doublon', async () => {
        route({
            '/user': { login: 'gerem66' },
            '/user/orgs': [{ login: 'Oxyfoo' }],
            '/user/repos': [
                { owner: { login: 'gerem66', type: 'User' } },
                { owner: { login: 'oxyfoo', type: 'Organization' } },
                { owner: { login: 'AphroMad', type: 'Organization' } }
            ]
        });
        assert.deepEqual(await listTokenOwners('tok'), [
            { login: 'gerem66', kind: 'self' },
            { login: 'AphroMad', kind: 'organization' },
            { login: 'oxyfoo', kind: 'organization' }
        ]);
    });

    it('se contente de ce qu’un jeton à portée réduite laisse lire', async () => {
        route({ '/user/repos': [{ owner: { login: 'Oxyfoo', type: 'Organization' } }] });
        assert.deepEqual(await listTokenOwners('tok'), [{ login: 'Oxyfoo', kind: 'organization' }]);
    });

    it('remonte l’erreur quand rien ne répond', async () => {
        route({});
        await assert.rejects(listTokenOwners('tok'), GitHubError);
    });
});

/** Un `fetch` qui répond selon le chemin demandé, et 404 ailleurs. */
function route(answers: Record<string, unknown>, status = 200) {
    globalThis.fetch = (async (input: string | URL | Request) => {
        const path = String(input).replace('https://api.github.com', '');
        const body = answers[path];
        return body === undefined
            ? new Response('{}', { status: 404 })
            : new Response(JSON.stringify(body), { status });
    }) as typeof fetch;
}

const at = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);

describe('ce qui met un dépôt en ligne', () => {
    it('rend les workflows réussis datés de leur fin et ceux en cours, jamais les échecs', async () => {
        route({
            '/repos/o/r/actions/runs?branch=main&per_page=20': {
                workflow_runs: [
                    { name: 'Deploy', status: 'completed', conclusion: 'success', updated_at: '2026-10-09T10:05:00Z' },
                    { name: 'Lint', status: 'completed', conclusion: 'failure', updated_at: '2026-10-09T10:06:00Z' },
                    { name: 'Deploy', status: 'in_progress', run_started_at: '2026-10-09T10:07:00Z' }
                ]
            }
        });
        assert.deepEqual(await fetchWorkflowRuns('o', 'r', 't', 'main'), [
            { state: 'success', at: at('2026-10-09T10:05:00Z'), what: 'le workflow « Deploy »' },
            { state: 'running', at: at('2026-10-09T10:07:00Z'), what: 'le workflow « Deploy »' }
        ]);
    });

    it('rend les déploiements GitHub réussis ou en cours, et ignore les aperçus et les trop anciens', async () => {
        route({
            '/repos/o/r/deployments?per_page=10': [
                { id: 1, environment: 'production', created_at: '2026-10-09T10:00:00Z' },
                { id: 2, environment: 'Preview', transient_environment: true, created_at: '2026-10-09T10:01:00Z' },
                { id: 3, environment: 'production', created_at: '2026-10-09T10:02:00Z' },
                { id: 4, environment: 'production', created_at: '2026-10-01T10:00:00Z' }
            ],
            '/repos/o/r/deployments/1/statuses?per_page=10': [
                { state: 'inactive', created_at: '2026-10-09T10:30:00Z' },
                { state: 'success', created_at: '2026-10-09T10:04:00Z' }
            ],
            '/repos/o/r/deployments/3/statuses?per_page=10': [
                { state: 'in_progress', created_at: '2026-10-09T10:03:00Z' }
            ]
        });
        const events = await fetchDeployments('o', 'r', 't', at('2026-10-09T09:00:00Z'));
        assert.deepEqual(
            events.sort((a, b) => a.at - b.at),
            [
                { state: 'running', at: at('2026-10-09T10:03:00Z'), what: 'le déploiement GitHub « production »' },
                { state: 'success', at: at('2026-10-09T10:04:00Z'), what: 'le déploiement GitHub « production »' }
            ]
        );
    });

    it('un jeton sans le droit lève un refus que le contrat sait lire', async () => {
        route({ '/repos/o/r/actions/runs?branch=main&per_page=20': { message: 'Resource not accessible' } }, 403);
        await assert.rejects(
            fetchWorkflowRuns('o', 'r', 't', 'main'),
            (e: unknown) => e instanceof GitHubError && e.status === 403
        );
    });

    it('résume la fenêtre : le succès le plus récent qui y tombe, un « en cours » récent', () => {
        const now = 10_000;
        const summary = summarizeActivity(
            [
                { state: 'success', at: 4_000, what: 'le workflow « Deploy »' },
                { state: 'success', at: 6_000, what: 'le déploiement GitHub « production »' },
                { state: 'success', at: 7_000, what: 'le workflow « Deploy »' },
                { state: 'running', at: now - 7 * 3600, what: 'le workflow « Oublié »' },
                { state: 'running', at: now - 60, what: 'le workflow « Deploy »' }
            ],
            5_000,
            'o/r',
            now
        );
        assert.deepEqual(summary, {
            succeeded: { at: 7_000, what: 'le workflow « Deploy » de o/r' },
            inFlight: { what: 'le workflow « Deploy » de o/r' }
        });
    });
});
