import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { summarize } from './stats';

describe('summarize', () => {
    it('rien à résumer sans échantillon', () => {
        assert.equal(summarize([]), null);
    });

    it('les centiles au rang le plus proche, arrondis au dixième', () => {
        const samples = Array.from({ length: 20 }, (_, i) => i + 1.04);
        assert.deepEqual(summarize(samples), { n: 20, p50: 10, p95: 19, max: 20, mean: 10.5 });
        assert.deepEqual(summarize([7.26]), { n: 1, p50: 7.3, p95: 7.3, max: 7.3, mean: 7.3 });
    });
});
