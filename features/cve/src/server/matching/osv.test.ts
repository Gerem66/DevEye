import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { cvss3Score, severityOfScore } from './cvss';
import type { Dependency } from '../inventory/lockfiles';
import { osvHealth, queryKey, queryOsv, type OsvCache, type VulnResponse } from './osv';

/**
 * Le client d'OSV, sur un réseau de papier : le cache commun, la pause après
 * un refus, la même faille sous deux noms, la gravité tirée du vecteur.
 */

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const lodash: Dependency = { ecosystem: 'npm', name: 'lodash', version: '4.17.20' };
const signal = new AbortController().signal;

function memoryCache(): OsvCache & { q: Map<string, string[]>; v: Map<string, VulnResponse> } {
    const q = new Map<string, string[]>();
    const v = new Map<string, VulnResponse>();
    return {
        q,
        v,
        queries: async (keys) => new Map(keys.filter((k) => q.has(k)).map((k) => [k, q.get(k)!])),
        saveQueries: async (entries) => entries.forEach((e) => q.set(e.key, e.vulnIds)),
        vulns: async (ids) => new Map(ids.filter((id) => v.has(id)).map((id) => [id, v.get(id)!])),
        saveVulns: async (entries) => entries.forEach((e) => v.set(e.id, e.body))
    };
}

beforeEach(() => {
    osvHealth.blockedUntil = 0;
    osvHealth.lastFailure = null;
});

describe('le cache commun', () => {
    it('ne redemande pas un paquet déjà connu, ni un avis déjà lu', async () => {
        const cache = memoryCache();
        const calls: string[] = [];
        const fetchImpl = async (url: string) => {
            calls.push(url);
            return url.endsWith('/querybatch')
                ? json({ results: [{ vulns: [{ id: 'GHSA-1' }] }] })
                : json({ id: 'GHSA-1', summary: 'Faille', database_specific: { severity: 'HIGH' } });
        };
        const first = await queryOsv([lodash], signal, { fetchImpl, cache });
        const second = await queryOsv([lodash], signal, { fetchImpl, cache });
        assert.equal(first.status, 'ok');
        assert.equal(second.status, 'ok');
        assert.equal(calls.length, 2, 'un lot et un avis, puis plus rien');
        assert.deepEqual(cache.q.get(queryKey(lodash)), ['GHSA-1']);
        // La clé ne dit rien du paquet : c'est une empreinte.
        assert.ok(!queryKey(lodash).includes('lodash'));
    });
});

describe('un OSV qui refuse', () => {
    it('rend « indisponible », puis plus aucun appel ne part avant la fin de la pause', async () => {
        const calls: string[] = [];
        const fetchImpl = async (url: string) => {
            calls.push(url);
            return json({}, 429, { 'retry-after': '120' });
        };
        const first = await queryOsv([lodash], signal, { fetchImpl });
        assert.equal(first.status, 'unavailable');
        assert.ok(osvHealth.blockedUntil > Date.now() + 100_000);
        const second = await queryOsv([lodash], signal, { fetchImpl });
        assert.equal(second.status, 'unavailable');
        assert.equal(calls.length, 1);
    });

    it('ne laisse pas un avis manquant passer pour une faille disparue', async () => {
        const fetchImpl = async (url: string) =>
            url.endsWith('/querybatch') ? json({ results: [{ vulns: [{ id: 'GHSA-1' }] }] }) : json({}, 503);
        const outcome = await queryOsv([lodash], signal, { fetchImpl });
        assert.equal(outcome.status, 'unavailable');
    });

    it('prend une panne réseau pour une indisponibilité, pas pour une erreur du passage', async () => {
        const fetchImpl = async () => {
            throw new TypeError('fetch failed');
        };
        assert.equal((await queryOsv([lodash], signal, { fetchImpl })).status, 'unavailable');
    });
});

describe('une même faille sous deux noms', () => {
    it('ne fait qu’un constat par dépendance, l’avis GitHub en premier', async () => {
        const fetchImpl = async (url: string) => {
            if (url.endsWith('/querybatch'))
                return json({ results: [{ vulns: [{ id: 'PYSEC-9' }, { id: 'GHSA-9' }] }] });
            const id = decodeURIComponent(url.split('/').pop() ?? '');
            return json({ id, summary: id, aliases: ['CVE-2024-1'] });
        };
        const outcome = await queryOsv([{ ecosystem: 'PyPI', name: 'flask', version: '1.0' }], signal, { fetchImpl });
        assert.equal(outcome.status, 'ok');
        if (outcome.status !== 'ok') return;
        assert.deepEqual(
            outcome.hits.map((h) => h.vuln.id),
            ['GHSA-9']
        );
    });
});

describe('la note CVSS', () => {
    it('suit la spécification 3.1', () => {
        assert.equal(cvss3Score('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H'), 9.8);
        assert.equal(cvss3Score('CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N'), 6.1);
        assert.equal(cvss3Score('CVSS:3.0/AV:L/AC:H/PR:H/UI:R/S:U/C:N/I:N/A:N'), 0);
        assert.equal(cvss3Score('CVSS:4.0/AV:N/AC:L'), null);
        assert.equal(severityOfScore(9.8), 'critical');
        assert.equal(severityOfScore(6.1), 'medium');
        assert.equal(severityOfScore(0), 'none');
    });
});
