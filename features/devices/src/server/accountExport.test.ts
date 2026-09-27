import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { gzipSync } from 'node:zlib';

import { accountExportProblem, type SdkQueryable } from '@deveye/types/sdk/server';

import { processLists } from './accountExport';
import { serverEntry } from './index';

/** Deux appareils, le premier avec trois instants dont un blob corrompu, le second sans rien. */
function fakeQueryable(): SdkQueryable {
    const samples: Record<string, { ts: number; kind: string; pinned: number; payload: Uint8Array }[]> = {
        a: [
            { ts: 1000, kind: 'top', pinned: 0, payload: gzipSync(JSON.stringify([{ name: 'nginx' }])) },
            { ts: 2000, kind: 'all', pinned: 1, payload: Buffer.from('pas du gzip') },
            { ts: 3000, kind: 'top', pinned: 0, payload: gzipSync('[]') }
        ],
        b: []
    };
    return {
        query: async <T extends object>(sql: string, params: unknown[] = []) => {
            if (sql.startsWith('SELECT id FROM devices')) return [{ id: 'a' }, { id: 'b' }] as T[];
            const [device, after] = params as [string, number];
            return (samples[device] ?? []).filter((row) => row.ts > after) as T[];
        },
        execute: async () => ({ affectedRows: 0, insertId: 0 })
    };
}

describe('export du compte', () => {
    it('déclare un sort valide pour chaque table', () => {
        assert.ok(serverEntry.accountExport, 'le module déclare son export');
        assert.equal(accountExportProblem(serverEntry.accountExport), null);
    });

    it('décompresse les listes de processus, et garde l’instant dont le blob est illisible', async () => {
        const rows = [];
        for await (const row of processLists(fakeQueryable(), 7, new AbortController().signal)) rows.push(row);
        assert.deepEqual(rows, [
            {
                device_id: 'a',
                ts: new Date(1000).toISOString(),
                kind: 'top',
                pinned: false,
                processes: [{ name: 'nginx' }]
            },
            { device_id: 'a', ts: new Date(2000).toISOString(), kind: 'all', pinned: true, processes: null },
            { device_id: 'a', ts: new Date(3000).toISOString(), kind: 'top', pinned: false, processes: [] }
        ]);
    });

    it('s’arrête quand le téléchargement s’interrompt', async () => {
        const stop = new AbortController();
        stop.abort();
        await assert.rejects(async () => {
            for await (const row of processLists(fakeQueryable(), 7, stop.signal)) assert.fail(String(row));
        });
    });
});
