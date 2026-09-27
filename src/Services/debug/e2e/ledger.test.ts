import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createLedger } from './ledger';

describe('le registre du ménage', () => {
    it('défait en ordre inverse, jusqu’au bout malgré un échec', async () => {
        const ledger = createLedger();
        const done: string[] = [];
        ledger.defer('compte', async () => void done.push('compte'));
        ledger.defer('site', async () => {
            throw new Error('introuvable');
        });
        ledger.defer('socket', async () => void done.push('socket'));
        const report = await ledger.cleanup();
        assert.deepEqual(done, ['socket', 'compte']);
        assert.deepEqual(report, { ok: false, failures: ['site : introuvable'] });
        assert.deepEqual(await ledger.cleanup(), { ok: true, failures: [] });
    });
});
