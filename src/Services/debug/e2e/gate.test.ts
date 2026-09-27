import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { RUN_HEADER, runGate } from './gate';

const request = (token: string | undefined, remoteAddress = '127.0.0.1') => ({
    headers: token === undefined ? {} : { [RUN_HEADER]: token },
    socket: { remoteAddress }
});

afterEach(() => runGate.close());

describe('la porte des essais', () => {
    it('ne s’ouvre qu’au jeton de l’essai en cours, et depuis ce serveur même', () => {
        const token = runGate.open();
        assert.equal(runGate.allows(request(token)), true);
        assert.equal(runGate.allows(request(token, '::ffff:127.0.0.1')), true);
        assert.equal(runGate.allows(request(token, '203.0.113.9')), false);
        assert.equal(runGate.allows(request('faux')), false);
        assert.equal(runGate.allows(request(undefined)), false);
    });

    it('fermée hors essai, et un ancien jeton ne vaut plus rien', () => {
        const old = runGate.open();
        runGate.close();
        assert.equal(runGate.allows(request(old)), false);
        runGate.open();
        assert.equal(runGate.allows(request(old)), false);
    });
});
