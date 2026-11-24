import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { itemDigest, itemTreeProblem } from '@deveye/types/sdk/server';
import { createTestContext } from '@deveye/types/sdk/testing';

import { labelRef, labelsTree } from './labels';

const { keys } = createTestContext();

describe('le condensé d’un site d’origine', () => {
    it('ne relie pas deux espaces qui reçoivent des visites du même site', () => {
        assert.match(labelRef(keys, 1, 'www.google.com'), /^[0-9a-f]{32}$/);
        assert.equal(labelRef(keys, 1, 'www.google.com'), labelRef(keys, 1, 'www.google.com'));
        assert.notEqual(labelRef(keys, 1, 'www.google.com'), labelRef(keys, 2, 'www.google.com'));
    });

    it('la reprise tire d’une étiquette le condensé que les compteurs lui donneraient', () => {
        assert.equal(itemTreeProblem(labelsTree), null);
        const [labels] = labelsTree;
        const digest = labels.digests?.[0];
        assert.ok(digest);
        const value = digest.of('www.google.com', { workspace_id: 4, kind: 'referrer' });
        assert.ok(value !== null);
        assert.equal(
            itemDigest(keys, digest, { workspaceId: 4, itemId: 12 }, value),
            labelRef(keys, 4, 'www.google.com')
        );
    });
});
