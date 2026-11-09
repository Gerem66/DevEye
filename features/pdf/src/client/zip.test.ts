import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { unzipSync } from 'fflate';

import { zipFiles } from './zip';

describe('archive zip', () => {
    it('range les fichiers tels quels, et distingue deux noms identiques', () => {
        const zip = zipFiles([
            { name: 'a.pdf', bytes: new Uint8Array([1, 2, 3]) },
            { name: 'a.pdf', bytes: new Uint8Array([4]) },
            { name: 'b.png', bytes: new Uint8Array([5]) }
        ]);
        const out = unzipSync(zip);
        assert.deepEqual(Object.keys(out).sort(), ['a (2).pdf', 'a.pdf', 'b.png']);
        assert.deepEqual([...out['a.pdf']], [1, 2, 3]);
        assert.deepEqual([...out['a (2).pdf']], [4]);
    });
});
