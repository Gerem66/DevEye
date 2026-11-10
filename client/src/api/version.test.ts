import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { versionVerdict } from './version';

describe('versionVerdict', () => {
    it('ne recharge pas quand le serveur porte la version du bundle', () => {
        assert.equal(versionVerdict('0.26.0', '0.26.0', null), 'current');
        assert.equal(versionVerdict('0.26.0', '0.26.0', '0.26.0'), 'current');
    });

    it('recharge pour une version serveur encore jamais vue', () => {
        assert.equal(versionVerdict('0.26.0', '0.25.6', null), 'reload');
        assert.equal(versionVerdict('0.26.1', '0.25.6', '0.26.0'), 'reload');
    });

    it('ne recharge qu’une fois par version serveur', () => {
        assert.equal(versionVerdict('0.26.0', '0.25.6', '0.26.0'), 'already');
    });
});
