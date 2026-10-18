import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, it } from 'node:test';

import { signatureHolds, updateSigningKeys } from './signing';

/** Une cible du manifeste publié par la CI (agent 0.25.0), signée par `deveye-sign`. */
const RELEASED = {
    sha256: 'ea267b36ec169e8403a74008d2a28b8592681aaec759d7d413df0f60c8385a88',
    signature: '9QPxJ1+lEFqGjxOFt4XVi0b/SrUkzQkh0bINMJvyfgfl82l/kqwQUdHv5axGcXiCCkDI19zIUBrjoWf9VepdAA=='
};

describe('signatureHolds', () => {
    it('accepte une signature de la CI avec la clé de agent/update-signing.pub', () => {
        const keys = updateSigningKeys();
        assert.equal(keys.length, 1);
        assert.equal(signatureHolds(keys, RELEASED.sha256, RELEASED.signature), true);
    });

    it('refuse une autre empreinte, une signature absente ou tronquée, une autre clé', () => {
        const keys = updateSigningKeys();
        assert.equal(signatureHolds(keys, 'f'.repeat(64), RELEASED.signature), false);
        assert.equal(signatureHolds(keys, RELEASED.sha256, undefined), false);
        assert.equal(signatureHolds(keys, RELEASED.sha256, RELEASED.signature.slice(0, 40)), false);
        assert.equal(signatureHolds(keys, 'pas une empreinte', RELEASED.signature), false);

        const other = generateKeyPairSync('ed25519');
        const forged = sign(null, Buffer.from(RELEASED.sha256, 'hex'), other.privateKey).toString('base64');
        assert.equal(signatureHolds(keys, RELEASED.sha256, forged), false);
        // Pendant une rotation, l'une ou l'autre clé suffit.
        assert.equal(signatureHolds([other.publicKey, ...keys], RELEASED.sha256, forged), true);
        assert.equal(signatureHolds([other.publicKey, ...keys], RELEASED.sha256, RELEASED.signature), true);
    });
});
