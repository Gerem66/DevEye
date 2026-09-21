import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isStale, refreshRates, type FxClient } from './fx';
import { memoryRepo } from './testing';

const HOUR = 3600;
const client: FxClient = () => Promise.resolve({ asOf: '2026-09-18', rates: { EUR: 1, USD: 1.17 } });
const broken: FxClient = () => Promise.reject(new Error('source muette'));

describe('taux de change', () => {
    it('range les taux, puis attend la prochaine relecture', async () => {
        const repo = memoryRepo();
        assert.equal(await refreshRates(repo, client, 10 * HOUR, 6 * HOUR), true);
        assert.deepEqual(repo.stored, { asOf: '2026-09-18', rates: { EUR: 1, USD: 1.17 } });
        assert.equal(await refreshRates(repo, client, 12 * HOUR, 6 * HOUR), false);
        assert.equal(await refreshRates(repo, client, 17 * HOUR, 6 * HOUR), true);
    });

    it('garde les derniers taux quand la source se tait, sans la marteler', async () => {
        const repo = memoryRepo();
        await refreshRates(repo, client, 10 * HOUR, 6 * HOUR);
        await assert.rejects(refreshRates(repo, broken, 17 * HOUR, 6 * HOUR));
        assert.equal(repo.stored.rates.USD, 1.17);
        assert.equal(
            await refreshRates(repo, broken, 17 * HOUR + 60, 6 * HOUR),
            false,
            'pas de nouvel essai avant un quart d’heure'
        );
    });

    it('dit des taux qu’ils datent après deux relectures manquées', () => {
        assert.equal(isStale(10 * HOUR, 20 * HOUR, 6 * HOUR), false);
        assert.equal(isStale(10 * HOUR, 23 * HOUR, 6 * HOUR), true);
    });
});
