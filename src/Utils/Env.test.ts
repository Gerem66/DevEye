import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { trustProxyOf } from './Env';

describe('trustProxyOf', () => {
    it('un entier est un nombre de sauts depuis le serveur', () => {
        const trust = trustProxyOf('1');
        assert.equal(typeof trust, 'function');
        if (typeof trust !== 'function') return;
        assert.equal(trust('10.0.0.1', 0), true);
        assert.equal(trust('203.0.113.7', 1), false, 'le second saut est le client : son en-tête ne compte pas');
    });

    it('zéro ne croit aucun en-tête', () => {
        const trust = trustProxyOf('0');
        if (typeof trust !== 'function') return assert.fail('attendu une fonction');
        assert.equal(trust('127.0.0.1', 0), false);
    });

    it('sinon, une liste d’adresses ou de CIDR', () => {
        assert.deepEqual(trustProxyOf('10.0.0.0/8, 127.0.0.1'), ['10.0.0.0/8', '127.0.0.1']);
    });
});
