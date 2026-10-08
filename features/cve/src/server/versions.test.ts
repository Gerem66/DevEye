import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { compareVersions, isAffected, type AffectedRange } from './versions';

const range = (over: Partial<AffectedRange>): AffectedRange => ({
    version: null,
    start_incl: null,
    start_excl: null,
    end_incl: null,
    end_excl: null,
    ...over
});

describe('la comparaison de versions', () => {
    it('compare segment par segment, un segment manquant valant zéro', () => {
        assert.ok(compareVersions('1.25.3', '1.25.10') < 0);
        assert.ok(compareVersions('20.11.1', '20.9.0') > 0);
        assert.equal(compareVersions('8.0', '8.0.0'), 0);
        assert.ok(compareVersions('3.0.0-rc1', '3.0.0') < 0);
    });

    it('dit si une version tombe dans une plage, bornes incluses ou exclues', () => {
        const fixed = range({ start_incl: '1.25.0', end_excl: '1.25.4' });
        assert.equal(isAffected('1.25.3', fixed), true);
        assert.equal(isAffected('1.25.4', fixed), false);
        assert.equal(isAffected('1.24.9', fixed), false);
        assert.equal(isAffected('2.0.0', range({ end_incl: '2.0.0' })), true);
        assert.equal(isAffected('1.25.3', range({ version: '1.25.3' })), true);
        assert.equal(isAffected('1.25.2', range({ version: '1.25.3' })), false);
    });

    it('ne prend pas « toutes les versions » pour une réponse, ni une version qui n’en est pas une', () => {
        assert.equal(isAffected('1.25.3', range({})), false);
        assert.equal(isAffected('latest', range({ end_excl: '2.0' })), false);
    });
});
