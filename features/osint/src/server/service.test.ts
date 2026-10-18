import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createTestServiceDeps } from '@deveye/types/sdk/testing';

import { OSINT_HISTORY_DAYS } from '../contracts/domain';
import type { OsintRepo } from './repo';
import { createService } from './service';

const DAY = 24 * 3600;

/** Les dates de création de l'historique, et le seul geste du dépôt que la purge emploie. */
function memoryLookups(created: number[]) {
    const rows = [...created];
    const repo: Pick<OsintRepo, 'purgeLookupsBefore'> = {
        purgeLookupsBefore(cutoff) {
            const kept = rows.filter((c) => c >= cutoff);
            const removed = rows.length - kept.length;
            rows.splice(0, rows.length, ...kept);
            return Promise.resolve(removed);
        }
    };
    return { repo: repo as OsintRepo, rows };
}

describe("la purge de l'historique", () => {
    it(`efface les recherches de plus de ${OSINT_HISTORY_DAYS} jours, au démarrage puis chaque jour`, async () => {
        const now = Math.floor(Date.now() / 1000);
        const recent = now - DAY;
        const kept = now - (OSINT_HISTORY_DAYS - 1) * DAY;
        const table = memoryLookups([recent, kept, now - (OSINT_HISTORY_DAYS + 1) * DAY]);
        const deps = createTestServiceDeps<OsintRepo>({ repo: table.repo });
        const service = createService(deps);

        await service.start();
        await service.stop();
        assert.deepEqual(table.rows, [recent, kept]);

        const [ticker] = deps.recorded.tickers;
        assert.equal(ticker?.intervalMs, DAY * 1000);
        table.rows.push(now - 400 * DAY);
        await ticker!.tick();
        assert.deepEqual(table.rows, [recent, kept]);
    });
});
