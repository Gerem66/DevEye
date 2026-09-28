import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { gunzipSync, gzipSync } from 'node:zlib';

import type { SdkQueryable } from '@deveye/types/sdk/server';

import { processSampleRepo } from './processSamples';

/**
 * L'allègement des vieilles listes : il garde les premières lignes (le classement
 * de l'agent), ne touche ni un instant épinglé ni une liste déjà réduite, et ne
 * relit pas indéfiniment un blob illisible.
 */

const list = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `p${i}`, cpuPercent: n - i }));

function fakeDb(rows: { device_id: string; ts: number; payload: Buffer }[]) {
    const selects: { sql: string; params: unknown[] }[] = [];
    const updates: { sql: string; params: unknown[] }[] = [];
    const q: SdkQueryable = {
        query: <T extends object>(sql: string, params: unknown[] = []) => {
            selects.push({ sql, params });
            return Promise.resolve(rows as unknown as T[]);
        },
        execute: (sql: string, params: unknown[] = []) => {
            updates.push({ sql, params });
            return Promise.resolve({ affectedRows: 1, insertId: 0 });
        }
    };
    return { q, selects, updates };
}

describe('processSamples.thinBefore', () => {
    it('réduit une liste complète à ses premières lignes, et dit ce qu’elle pèse désormais', async () => {
        const db = fakeDb([{ device_id: 'd1', ts: 1000, payload: gzipSync(JSON.stringify(list(30))) }]);
        assert.equal(await processSampleRepo(db.q).thinBefore(5000, 20, 200), 1);

        const [select] = db.selects;
        assert.match(select.sql, /kind = 'all' AND pinned = 0 AND ts < \?/);
        assert.match(select.sql, /ORDER BY ts ASC\s+LIMIT 200/);
        assert.deepEqual(select.params, [5000]);

        const [update] = db.updates;
        assert.match(update.sql, /SET kind = 'top', proc_count = \?, payload_bytes = \?, payload = \?/);
        assert.match(update.sql, /kind = 'all' AND pinned = 0/);
        const [count, bytes, payload, device, ts] = update.params as [number, number, Buffer, string, number];
        assert.equal(count, 20);
        assert.equal(bytes, payload.length);
        assert.deepEqual(JSON.parse(gunzipSync(payload).toString('utf8')), list(30).slice(0, 20));
        assert.deepEqual([device, ts], ['d1', 1000]);
    });

    it('marque un blob illisible sans le réécrire', async () => {
        const db = fakeDb([{ device_id: 'd1', ts: 1000, payload: Buffer.from('pas du gzip') }]);
        await processSampleRepo(db.q).thinBefore(5000, 20, 200);
        assert.equal(db.updates.length, 1);
        assert.match(db.updates[0].sql, /SET kind = 'top'\s+WHERE/);
        assert.deepEqual(db.updates[0].params, ['d1', 1000]);
    });
});
