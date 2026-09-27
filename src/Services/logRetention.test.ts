import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Database } from '@/db';
import { LOG_RETENTION_DAYS, purgeExpiredLogs } from './logRetention';

const DAY = 24 * 3600;

/** Une table de dates, et le DELETE … LIMIT que le repo exécute. */
function memoryLogs(dates: number[]) {
    let rows = [...dates];
    const calls: number[] = [];
    const db = {
        logs: {
            purgeBefore: (cutoff: number, batch: number) => {
                const old = rows.filter((d) => d < cutoff).slice(0, batch);
                rows = rows.filter((d) => !old.includes(d));
                calls.push(old.length);
                return Promise.resolve(old.length);
            }
        }
    } as unknown as Pick<Database, 'logs'>;
    return { db, rows: () => rows, calls };
}

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
