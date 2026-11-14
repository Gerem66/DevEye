import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { majorKey, majorsBehind, readPackage } from './registry';

describe('les registres', () => {
    it('lisent la dernière version et les versions dépréciées', () => {
        const meta = readPackage({
            versions: [
                { versionKey: { version: '1.0.0' }, isDeprecated: true, deprecatedReason: 'use v2' },
                { versionKey: { version: '2.1.0' }, isDefault: true }
            ]
        });
        assert.deepEqual(meta, { latest: '2.1.0', deprecated: { '1.0.0': 'use v2' } });
    });

    it('comptent les majeures de retard, la mineure faisant foi en 0.x', () => {
        assert.equal(majorsBehind('4.17.21', '5.0.0'), 1);
        assert.equal(majorsBehind('18.2.0', '19.1.0'), 1);
        assert.equal(majorsBehind('2.0.0', '2.9.0'), 0);
        assert.equal(majorsBehind('0.3.1', '0.5.0'), 2);
        assert.equal(majorsBehind('0.9.0', '1.2.0'), 1);
        assert.equal(majorKey('0.5.2'), '0.5');
        assert.equal(majorKey('19.1.0'), '19');
    });
});
