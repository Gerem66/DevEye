import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { publicLookup, safeFetch, UnsafeTargetError } from './netFetch';

describe('safeFetch', () => {
    it('refuse une cible interne avant toute connexion', async () => {
        for (const url of [
            'http://127.0.0.1:3306/',
            'http://169.254.169.254/latest/meta-data/',
            'http://10.0.0.5/',
            'http://[::1]/',
            'http://localhost/',
            'file:///etc/passwd',
            'javascript:alert(1)'
        ]) {
            await assert.rejects(safeFetch(url), UnsafeTargetError, url);
        }
    });
});

describe('publicLookup', () => {
    it('refuse un nom qui résout vers une adresse non publique', (_, done) => {
        // `localhost` passe par le résolveur système : c'est le cas d'un nom
        // public dont l'enregistrement pointe vers l'intérieur.
        publicLookup('localhost', {}, (err) => {
            assert.equal(err?.code, 'ENOTPUBLIC');
            done();
        });
    });
});
