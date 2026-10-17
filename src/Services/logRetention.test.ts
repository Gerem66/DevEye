import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Database } from '@/db';
import { LOGIN_HISTORY_DAYS } from '@deveye/types';
import { LOG_RETENTION_DAYS, purgeExpiredLoginHistory, purgeExpiredLogs } from './logRetention';

const DAY = 24 * 3600;

/** Une table de dates, et le DELETE … LIMIT que le repo exécute, sous le nom du dépôt voulu. */
function memoryTable(repo: 'logs' | 'loginHistory', dates: number[]) {
    let rows = [...dates];
    const calls: number[] = [];
    const purgeBefore = (cutoff: number, batch: number) => {
        const old = rows.filter((d) => d < cutoff).slice(0, batch);
        rows = rows.filter((d) => !old.includes(d));
        calls.push(old.length);
        return Promise.resolve(old.length);
    };
    const db = { [repo]: { purgeBefore } } as unknown as Pick<Database, 'logs' | 'loginHistory'>;
    return { db, rows: () => rows, calls };
}

const memoryLogs = (dates: number[]) => memoryTable('logs', dates);

describe('purgeExpiredLogs', () => {
    const now = 1_800_000_000;

    it('garde ce qui est dans la durée, supprime le reste', async () => {
        const recent = now - 300 * DAY;
        const expired = now - 400 * DAY;
        const table = memoryLogs([recent, expired, expired - 1]);
        const removed = await purgeExpiredLogs(table.db, now * 1000);
        assert.equal(removed, 2);
        assert.deepEqual(table.rows(), [recent]);
    });

    it('la limite est la durée exacte, pas un jour de plus', async () => {
        const edge = now - LOG_RETENTION_DAYS * DAY;
        const table = memoryLogs([edge, edge - 1]);
        await purgeExpiredLogs(table.db, now * 1000);
        assert.deepEqual(table.rows(), [edge]);
    });

    it('enchaîne les lots jusqu’à un lot incomplet', async () => {
        const expired = Array.from({ length: 12_000 }, (_, i) => now - 400 * DAY - i);
        const table = memoryLogs(expired);
        const removed = await purgeExpiredLogs(table.db, now * 1000);
        assert.equal(removed, 12_000);
        assert.deepEqual(table.calls, [5000, 5000, 2000]);
    });
});

describe('purgeExpiredLoginHistory', () => {
    const now = 1_800_000_000;

    it('garde les connexions dans la durée, supprime les autres', async () => {
        const edge = now - LOGIN_HISTORY_DAYS * DAY;
        const table = memoryTable('loginHistory', [now - DAY, edge, edge - 1]);
        const removed = await purgeExpiredLoginHistory(table.db, now * 1000);
        assert.equal(removed, 1);
        assert.deepEqual(table.rows(), [now - DAY, edge]);
    });
});
