import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { fakeQueryable } from '../pool.fake';
import { logsRepo } from './logs';

/**
 * Le journal d'administration : ses filtres composent une clause WHERE, et tout
 * ce que l'écran saisit doit finir en paramètre lié, jamais dans le texte de la
 * requête.
 */

const PAGE = { limit: 20, offset: 40 };

const normalize = (sql: string): string => sql.replace(/\s+/g, ' ').trim();

describe('la lecture du journal', () => {
    it('lit tout, sans WHERE, quand rien ne filtre', async () => {
        const q = fakeQueryable();
        await logsRepo(q).query({}, PAGE);
        const [count, page] = q.queries;
        assert.doesNotMatch(count!.sql, /WHERE/);
        assert.deepEqual(count!.params, []);
        assert.doesNotMatch(page!.sql, /WHERE/);
        assert.deepEqual(page!.params, [20, 40]);
    });

    it('combine les filtres en ET, chaque valeur liée dans l’ordre des clauses', async () => {
        const q = fakeQueryable();
        await logsRepo(q).query({ uid: 7, levelMin: 2, dateFrom: 10, dateTo: 20, category: 'auth' }, PAGE);
        const [count, page] = q.queries;
        assert.match(
            normalize(count!.sql),
            /WHERE l\.uid = \? AND l\.category = \? AND l\.level >= \? AND l\.date >= \? AND l\.date <= \?$/
        );
        assert.deepEqual(count!.params, [7, 'auth', 2, 10, 20]);
        assert.deepEqual(page!.params, [7, 'auth', 2, 10, 20, 20, 40]);
    });

    it('lie la recherche en motif LIKE, sans jamais la coller dans le SQL', async () => {
        const q = fakeQueryable();
        const term = "x'; DROP TABLE logs; --";
        await logsRepo(q).query({ search: term }, PAGE);
        const [count, page] = q.queries;
        for (const { sql } of q.queries) assert.ok(!sql.includes(term));
        assert.deepEqual(count!.params, [`%${term}%`, `%${term}%`, `%${term}%`]);
        assert.deepEqual(page!.params, [`%${term}%`, `%${term}%`, `%${term}%`, 20, 40]);
    });

    it('rend les lignes converties et le total, même quand MySQL les compte en chaîne', async () => {
        const q = fakeQueryable((sql) =>
            sql.includes('COUNT(*)')
                ? [{ total: '3' }]
                : [
                      {
                          id: 1,
                          date: '1700000000',
                          level: 1,
                          source: 'web',
                          category: 'c',
                          action: 'a',
                          uid: 1,
                          ip: '::1',
                          description: 'd',
                          metadata: '{"k":1}',
                          username: null
                      }
                  ]
        );
        const page = await logsRepo(q).query({}, PAGE);
        assert.equal(page.total, 3);
        assert.equal(page.logs[0]!.date, 1700000000);
        assert.deepEqual(page.logs[0]!.metadata, { k: 1 });
        assert.equal(page.logs[0]!.username, null);
    });
});

describe('l’écriture du journal', () => {
    it('sérialise les métadonnées en JSON, et lie NULL quand il n’y en a pas', async () => {
        const q = fakeQueryable();
        const repo = logsRepo(q);
        const base = { uid: 1, ip: '::1', source: 'web', category: 'c', action: 'a', level: 1, description: 'd' };
        await repo.record({ ...base, metadata: { a: 1 } });
        await repo.record(base);
        assert.equal(q.queries[0]!.params.at(-1), '{"a":1}');
        assert.equal(q.queries[1]!.params.at(-1), null);
    });

    it('purge par lot borné et dit combien de lignes sont parties', async () => {
        const q = fakeQueryable(() => ({ rowCount: 42 }));
        const gone = await logsRepo(q).purgeBefore(1000, 500);
        assert.equal(gone, 42);
        assert.match(q.queries[0]!.sql, /LIMIT \?$/);
        assert.deepEqual(q.queries[0]!.params, [1000, 500]);
    });
});
