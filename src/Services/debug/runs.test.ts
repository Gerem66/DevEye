import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { DebugBenchReport } from '@deveye/types';

import type { Database } from '@/db';
import type { DebugRunRow } from '@/db/repos/debug';
import { createRunRegistry } from './runs';

function fakeDb() {
    const rows = new Map<number, DebugRunRow>();
    let next = 0;
    const debug = {
        insertRun: async (input: { kind: 'e2e' | 'bench'; started: number; report: string }) => {
            const id = ++next;
            rows.set(id, {
                id,
                kind: input.kind,
                status: 'running',
                started: input.started,
                finished: null,
                report: input.report,
                launchedBy: null
            });
            return id;
        },
        finishRun: async (id: number, input: { status: DebugRunRow['status']; finished: number; report: string }) => {
            Object.assign(rows.get(id)!, input);
        },
        getRun: async (id: number) => rows.get(id) ?? null,
        listRuns: async () => [...rows.values()].reverse(),
        prune: async () => undefined,
        abortStale: async () => 0
    };
    return { rows, db: { debug } as unknown as Pick<Database, 'debug'> };
}

const report = (): DebugBenchReport => ({ kind: 'bench', profile: 'quick', probes: [], context: null });
const launcher = { id: 1, username: 'admin' };
const logger = { error: () => undefined, warn: () => undefined };

describe('les essais', () => {
    it('un seul à la fois, et son rapport s’écrit à la fin', async () => {
        const { db, rows } = fakeDb();
        const runs = createRunRegistry({ db, origin: 'o', logger });
        let finish!: () => void;
        const id = await runs.start(
            launcher,
            report(),
            () => new Promise<boolean>((resolve) => (finish = () => resolve(true)))
        );
        assert.deepEqual(runs.active(), { id, kind: 'bench' });
        await assert.rejects(
            runs.start(launcher, report(), async () => true),
            /déjà en cours, lancé par admin/
        );
        await assert.rejects(
            runs.withLock(async () => 1),
            /déjà en cours/
        );
        assert.equal((await runs.get(id))?.status, 'running');
        finish();
        while (runs.active()) await new Promise((resolve) => setTimeout(resolve, 0));
        assert.equal(rows.get(id)?.status, 'passed');
        assert.equal(runs.active(), null);
        assert.equal(await runs.withLock(async () => 1), 1);
    });

    it('arrêté, il fait son ménage et finit « arrêté » ; une erreur le met en échec', async () => {
        const { db, rows } = fakeDb();
        const runs = createRunRegistry({ db, origin: 'o', logger });
        const id = await runs.start(
            launcher,
            report(),
            ({ signal }) => new Promise<boolean>((resolve) => signal.addEventListener('abort', () => resolve(false)))
        );
        assert.equal(runs.abort(id), true);
        await runs.shutdown();
        assert.equal(rows.get(id)?.status, 'aborted');
        const failed = await runs.start(launcher, report(), async () => {
            throw new Error('panne');
        });
        await runs.shutdown();
        await new Promise((resolve) => setTimeout(resolve, 0));
        assert.equal(rows.get(failed)?.status, 'failed');
        assert.equal(runs.abort(failed), false);
    });
});
