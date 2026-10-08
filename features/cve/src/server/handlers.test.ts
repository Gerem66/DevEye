import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { z, ZodType } from 'zod';

import type { SdkFeatureContext } from '@deveye/types/sdk/server';
import { createTestContext } from '@deveye/types/sdk/testing';

import { cveGet, cveNews, cveSearch, cveSetFavorite, cveSetKey } from '../contracts/commands';
import type { CveEntryWithFavoriteRow } from '../contracts/domain';
import { manifest } from '../manifest';

import { cveHandlers, setNvdClient } from './handlers';
import type { NvdClient } from './nvd';
import type { CveRepo, CveStateKey, CveUpsert } from './repo';

/**
 * Ce qui se vérifie ici ne lève nulle part ailleurs : la recherche ne doit
 * consulter le NVD que quand le catalogue local ne suffit pas, une CVE inconnue
 * doit pouvoir être épinglée quand même, et une clé posée ne doit jamais
 * revenir.
 */

function handlerFor<C extends { command: string; input: ZodType; output: ZodType }>(contract: C) {
    const def = cveHandlers.find((h) => h.command === contract.command);
    assert.ok(def, `handler ${contract.command} manquant`);
    return def.handler as (
        ctx: SdkFeatureContext<CveRepo>,
        input: z.output<C['input']>
    ) => Promise<z.input<C['output']>>;
}

function entry(id: string, over: Partial<CveUpsert> = {}): CveUpsert {
    return {
        id,
        published: 1_700_000_000,
        lastModified: 1_700_000_000,
        severity: 'high',
        score: 7.5,
        vector: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N',
        cwe: 'CWE-79',
        summary: `Résumé de ${id}`,
        references: [],
        products: [],
        ...over
    };
}

function toRow(e: CveUpsert, favorite: boolean): CveEntryWithFavoriteRow {
    return {
        cve_id: e.id,
        published: e.published,
        last_modified: e.lastModified,
        severity: e.severity,
        score: e.score,
        vector: e.vector,
        cwe: e.cwe,
        summary: e.summary,
        refs: JSON.stringify(e.references),
        fetched_at: e.published,
        favorite: favorite ? e.id : null
    };
}

interface FakeRepo extends CveRepo {
    entries: CveUpsert[];
    favorites: string[];
}

/** Un dépôt en mémoire, même contrat que le vrai. */
function fakeRepo(seed: CveUpsert[] = []): FakeRepo {
    const state = new Map<CveStateKey, number>();
    return {
        entries: [...seed],
        favorites: [],
        async listNews(_ws, severity, limit) {
            return this.entries
                .filter((e) => severity === 'all' || e.severity === severity)
                .sort((a, b) => b.published - a.published)
                .slice(0, limit)
                .map((e) => toRow(e, this.favorites.includes(e.id)));
        },
        async search(_ws, terms, severity, limit) {
            return this.entries
                .filter((e) => severity === 'all' || e.severity === severity)
                .filter((e) => terms.every((t) => `${e.id} ${e.summary}`.toLowerCase().includes(t.toLowerCase())))
                .slice(0, limit + 1)
                .map((e) => toRow(e, this.favorites.includes(e.id)));
        },
        async find(_ws, cveId) {
            const found = this.entries.find((e) => e.id === cveId);
            return found ? toRow(found, this.favorites.includes(cveId)) : null;
        },
        async listFavorites(_ws) {
            return this.entries.filter((e) => this.favorites.includes(e.id)).map((e) => toRow(e, true));
        },
        async upsertMany(rows) {
            for (const row of rows) {
                const i = this.entries.findIndex((e) => e.id === row.id);
                if (i === -1) this.entries.push(row);
                else this.entries[i] = row;
            }
            return rows.length;
        },
        async addFavorite(_ws, cveId) {
            if (!this.favorites.includes(cveId)) this.favorites.push(cveId);
        },
        async removeFavorite(_ws, cveId) {
            const i = this.favorites.indexOf(cveId);
            if (i !== -1) this.favorites.splice(i, 1);
        },
        async purge() {
            return 0;
        },
        async watch() {
            return 0;
        },
        async listWatched() {
            return [];
        },
        async setBackfill() {},
        async affecting() {
            return [];
        },
        async getState(key) {
            return state.get(key) ?? null;
        },
        async setState(key, value) {
            state.set(key, value);
        }
    };
}

/** Un NVD en mémoire, qui compte ses appels : c'est ce que les tests mesurent. */
function fakeNvd(catalogue: CveUpsert[] = []) {
    const calls = { byId: 0, keyword: 0, window: 0 };
    const client: NvdClient = {
        async window() {
            calls.window += 1;
            return catalogue;
        },
        async product() {
            return { entries: [], next: 0, done: true };
        },
        async byId(cveId) {
            calls.byId += 1;
            return catalogue.find((e) => e.id === cveId) ?? null;
        },
        async keyword(query) {
            calls.keyword += 1;
            return catalogue.filter((e) => e.summary.toLowerCase().includes(query.toLowerCase()));
        }
    };
    setNvdClient(client);
    return calls;
}

describe('cve.news', () => {
    it('rend le fil filtré par gravité, avec l’instant du dernier tour', async () => {
        const repo = fakeRepo([entry('CVE-2024-0001'), entry('CVE-2024-0002', { severity: 'low', score: 2.1 })]);
        await repo.setState('ingestedAt', 1_700_000_500);
        const ctx = createTestContext({ repo });

        const out = await handlerFor(cveNews)(ctx, { severity: 'high', limit: 50 });
        assert.equal(out.entries.length, 1);
        assert.equal(out.entries[0].id, 'CVE-2024-0001');
        assert.equal(out.ingestedAt, 1_700_000_500);
    });
});

describe('cve.search', () => {
    it('se contente du catalogue local quand il suffit', async () => {
        const repo = fakeRepo([entry('CVE-2021-44228', { summary: 'Apache Log4j2 JNDI' })]);
        const calls = fakeNvd();
        const ctx = createTestContext({ repo });

        const out = await handlerFor(cveSearch)(ctx, { query: 'log4j', severity: 'all', limit: 1 });
        assert.equal(out.entries.length, 1);
        assert.equal(out.remote, false);
        assert.equal(calls.keyword, 0);
    });

    it('complète chez le NVD quand le local ne suffit pas, et met en cache', async () => {
        const repo = fakeRepo();
        const calls = fakeNvd([entry('CVE-2024-3094', { summary: 'xz backdoor' })]);
        const ctx = createTestContext({ repo });

        const out = await handlerFor(cveSearch)(ctx, { query: 'xz', severity: 'all', limit: 50 });
        assert.equal(calls.keyword, 1);
        assert.equal(out.remote, true);
        assert.equal(out.remoteError, null);
        assert.equal(out.entries.length, 1);
        // Ce que le NVD a rendu rejoint le catalogue, pour la prochaine fois.
        assert.equal(repo.entries.length, 1);
    });

    it('reconnaît un numéro tapé sans son préfixe et le demande par identifiant', async () => {
        // Le `keywordSearch` du NVD ignore les identifiants : sans passer par
        // `cveId`, « 2026-6785 » ne rendrait que ce que le local a déjà vu.
        const repo = fakeRepo([entry('CVE-2026-67854'), entry('CVE-2026-67858')]);
        const calls = fakeNvd([entry('CVE-2026-6785')]);
        const ctx = createTestContext({ repo });

        const out = await handlerFor(cveSearch)(ctx, { query: '2026-6785', severity: 'all', limit: 60 });
        assert.equal(calls.byId, 1);
        assert.equal(calls.keyword, 0);
        // Et elle vient en tête : c'est celle qu'on a demandée.
        assert.equal(out.entries[0].id, 'CVE-2026-6785');
        assert.equal(out.entries.length, 3);
    });

    it('interroge le NVD pour une CVE précise même quand le local remplit la page', async () => {
        const repo = fakeRepo([entry('CVE-2026-67854'), entry('CVE-2026-67858')]);
        const calls = fakeNvd([entry('CVE-2026-6785')]);
        const ctx = createTestContext({ repo });

        // limit 2 : le local suffirait à remplir, mais la CVE désignée manque.
        const out = await handlerFor(cveSearch)(ctx, { query: 'CVE-2026-6785', severity: 'all', limit: 2 });
        assert.equal(calls.byId, 1);
        assert.equal(out.entries[0].id, 'CVE-2026-6785');
    });

    it('se passe du NVD quand le local tient déjà la CVE désignée', async () => {
        const repo = fakeRepo([entry('CVE-2026-6785')]);
        const calls = fakeNvd([entry('CVE-2026-6785')]);
        const ctx = createTestContext({ repo });

        const out = await handlerFor(cveSearch)(ctx, { query: '2026-6785', severity: 'all', limit: 60 });
        assert.equal(calls.byId, 0);
        assert.equal(out.remote, false);
        assert.equal(out.entries[0].id, 'CVE-2026-6785');
    });

    it('reconnaît un identifiant et rend ce que le local a quand le NVD manque', async () => {
        const repo = fakeRepo();
        setNvdClient({
            window: () => Promise.reject(new Error('quota')),
            product: () => Promise.reject(new Error('quota')),
            byId: () => Promise.reject(new Error('Quota du NVD atteint, réessayer plus tard.')),
            keyword: () => Promise.reject(new Error('quota'))
        });
        const ctx = createTestContext({ repo });

        const out = await handlerFor(cveSearch)(ctx, { query: 'CVE-2024-3094', severity: 'all', limit: 50 });
        assert.equal(out.entries.length, 0);
        assert.equal(out.remote, true);
        assert.match(out.remoteError ?? '', /Quota/);
    });
});

describe('cve.get', () => {
    it('va chercher chez le NVD ce que le catalogue ignore, puis le range', async () => {
        const repo = fakeRepo();
        const calls = fakeNvd([entry('CVE-2024-3094')]);
        const ctx = createTestContext({ repo });

        const out = await handlerFor(cveGet)(ctx, { id: 'CVE-2024-3094' });
        assert.equal(out.entry.id, 'CVE-2024-3094');
        assert.equal(calls.byId, 1);
        assert.equal(repo.entries.length, 1);
    });

    it('refuse un identifiant que le NVD ne connaît pas', async () => {
        fakeNvd();
        const ctx = createTestContext({ repo: fakeRepo() });
        await assert.rejects(handlerFor(cveGet)(ctx, { id: 'CVE-1999-9999' }), /inconnue du NVD/);
    });
});

describe('cve.setFavorite', () => {
    it('épingle une CVE absente du catalogue en la ramenant d’abord', async () => {
        const repo = fakeRepo();
        const calls = fakeNvd([entry('CVE-2024-3094')]);
        const ctx = createTestContext({ repo });

        const out = await handlerFor(cveSetFavorite)(ctx, { id: 'CVE-2024-3094', favorite: true });
        assert.equal(out.entry.isFavorite, true);
        assert.equal(calls.byId, 1);
        assert.deepEqual(repo.favorites, ['CVE-2024-3094']);
        assert.equal(ctx.recorded.audits.length, 1);
    });

    it('retire une épingle sans toucher au catalogue', async () => {
        const repo = fakeRepo([entry('CVE-2024-3094')]);
        repo.favorites.push('CVE-2024-3094');
        const calls = fakeNvd();
        const ctx = createTestContext({ repo });

        const out = await handlerFor(cveSetFavorite)(ctx, { id: 'CVE-2024-3094', favorite: false });
        assert.equal(out.entry.isFavorite, false);
        assert.equal(calls.byId, 0);
        assert.equal(repo.entries.length, 1);
    });
});

describe('cve.setKey', () => {
    it('pose puis efface la clé sans jamais la rendre', async () => {
        // Le manifest, sans quoi aucune permission propre n'est déclarée et la
        // garde de `manageKeys` refuse même le propriétaire.
        const ctx = createTestContext({ repo: fakeRepo(), manifest });

        const set = await handlerFor(cveSetKey)(ctx, { provider: 'nvd', key: 'secret-du-nvd' });
        assert.deepEqual(set.keys, [{ provider: 'nvd', hasKey: true }]);
        assert.ok(!JSON.stringify(set).includes('secret-du-nvd'));

        const cleared = await handlerFor(cveSetKey)(ctx, { provider: 'nvd', key: '' });
        assert.deepEqual(cleared.keys, [{ provider: 'nvd', hasKey: false }]);
    });

    it('refuse sans la permission « Gérer les clés d’API », propriétaire ou non', async () => {
        const ctx = createTestContext({ repo: fakeRepo(), manifest, isOwner: false });
        await assert.rejects(handlerFor(cveSetKey)(ctx, { provider: 'nvd', key: 'secret-du-nvd' }), {
            code: 'forbidden'
        });
    });
});
