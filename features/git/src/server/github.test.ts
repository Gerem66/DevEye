import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { authorRef, fetchPullRequests, fetchRepoInfo, GitHubError, nameRef } from './github';

/**
 * Les fonctions pures de l'adaptateur GitHub, et ses décodeurs.
 *
 * Ce qui mérite d'être tenu : les **condensés** portent l'unicité que le
 * chiffré ne peut pas porter (une adresse d'auteur se normalise, un nom de
 * branche non), l'**état d'une pull request** se déduit de `merged_at` et non
 * du `state` du fournisseur, qui confond fusionnée et fermée, et un **304**
 * rend `data: null` avec l'ETag fourni, sans rien coûter au quota.
 */

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
