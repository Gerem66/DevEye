import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';

import { e2eRunOf, instanceTag, isTestEmail, newRunId, testIdentity, TEST_MAIL_DOMAIN } from './identity';

describe('les identités d’essai', () => {
    it('une adresse du domaine réservé, qu’un formulaire accepte, et qui dit son essai', () => {
        const run = newRunId();
        const who = testIdentity(run, 3);
        assert.ok(z.string().email().safeParse(who.email).success);
        assert.ok(who.email.endsWith(`@${TEST_MAIL_DOMAIN}`));
        assert.equal(e2eRunOf(who.email), `${instanceTag()}-${run}`);
        assert.equal(isTestEmail(who.email.toUpperCase()), true);
        assert.ok(who.password.length >= 24);
    });

    it('une autre adresse n’est jamais un compte d’essai', () => {
        assert.equal(e2eRunOf('alice@exemple.fr'), null);
        assert.equal(e2eRunOf(`nimporte@${TEST_MAIL_DOMAIN}`), null);
        assert.equal(isTestEmail('e2e@e2e.deveye.invalid.exemple.fr'), false);
    });

    it('deux serveurs n’ont pas la même étiquette', () => {
        assert.notEqual(instanceTag('https://app.deveye.fr'), instanceTag('http://localhost:5173'));
        assert.equal(instanceTag('https://app.deveye.fr/'), instanceTag('https://app.deveye.fr'));
    });
});
