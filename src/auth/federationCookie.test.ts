import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { openFederationOrigins, sealFederationOrigins } from './federationCookie';

describe('federationCookie', () => {
    it('rend les origines qu’il a scellées', () => {
        const origins = ['https://a.example', 'http://10.0.0.4:3000'];
        assert.deepEqual(openFederationOrigins(sealFederationOrigins(origins)), origins);
    });

    it('ne rend rien d’un cookie forgé ou altéré', () => {
        const sealed = sealFederationOrigins(['https://a.example']);
        const forged = Buffer.from(JSON.stringify(['https://evil.example'])).toString('base64url');
        assert.deepEqual(openFederationOrigins(`${forged}.${sealed.split('.')[1]}`), []);
        assert.deepEqual(openFederationOrigins(forged), []);
        assert.deepEqual(openFederationOrigins(undefined), []);
    });

    it('ne rend rien si une seule origine n’est pas canonique', () => {
        assert.deepEqual(
            openFederationOrigins(sealFederationOrigins(['https://a.example', 'https://b.example; script-src *'])),
            []
        );
        assert.deepEqual(openFederationOrigins(sealFederationOrigins(['https://a.example/'])), []);
    });
});
