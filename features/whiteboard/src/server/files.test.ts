import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { decodeDataUrl, looksLike } from './files';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

describe('decodeDataUrl et looksLike', () => {
    it('lit une data URL stricte et reconnaît le format par ses octets', () => {
        const bytes = decodeDataUrl(`data:image/png;base64,${PNG.toString('base64')}`, 'image/png');
        assert.equal(looksLike(bytes, 'image/png'), true);
        assert.equal(looksLike(bytes, 'image/jpeg'), false);
        assert.equal(looksLike(Buffer.from('<svg xmlns="x"></svg>'), 'image/svg+xml'), true);
    });

    it('refuse un type qui ne correspond pas ou un base64 de travers', () => {
        assert.throws(() => decodeDataUrl(`data:image/gif;base64,${PNG.toString('base64')}`, 'image/png'), {
            code: 'validation'
        });
        assert.throws(() => decodeDataUrl('data:image/png;base64,abc', 'image/png'), { code: 'validation' });
        assert.throws(() => decodeDataUrl('data:image/png;base64,', 'image/png'), { code: 'validation' });
    });
});
