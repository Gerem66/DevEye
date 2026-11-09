import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { formatRanges, parseRanges } from './ranges';

describe('plages de pages', () => {
    it('lit des numéros, des plages et des bornes ouvertes', () => {
        assert.deepEqual(parseRanges('1-3, 7, 10-', 12), [0, 1, 2, 6, 9, 10, 11]);
        assert.deepEqual(parseRanges('-2', 5), [0, 1]);
        assert.deepEqual(parseRanges('3-1', 5), [2, 1, 0]);
        assert.deepEqual(parseRanges('2 ; 2, 2', 5), [1]);
    });

    it('refuse ce qui ne se lit pas ou sort du document', () => {
        assert.equal(parseRanges('', 5), null);
        assert.equal(parseRanges('0', 5), null);
        assert.equal(parseRanges('6', 5), null);
        assert.equal(parseRanges('1-9', 5), null);
        assert.equal(parseRanges('a', 5), null);
        assert.equal(parseRanges('-', 5), null);
        assert.equal(parseRanges('1--2', 5), null);
    });

    it('écrit des plages lisibles', () => {
        assert.equal(formatRanges([0, 1, 2, 6, 9, 10, 11]), '1-3, 7, 10-12');
        assert.equal(formatRanges([4, 2, 2]), '3, 5');
        assert.equal(formatRanges([]), '');
    });
});
