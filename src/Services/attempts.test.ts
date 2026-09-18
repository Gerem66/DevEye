import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    assertAttemptAllowed,
    clearAttempts,
    LockedOutError,
    lockoutMsFor,
    recordFailedAttempt,
    sweepAttemptsForTest
} from './attempts';

describe('le verrouillage progressif', () => {
    it('monte par paliers : 5 échecs 30 s, 10 échecs 5 min, 20 échecs 1 h', () => {
        assert.equal(lockoutMsFor(4), 0);
        assert.equal(lockoutMsFor(5), 30_000);
        assert.equal(lockoutMsFor(10), 300_000);
        assert.equal(lockoutMsFor(20), 3_600_000);
    });

    it('verrouille la cible au cinquième échec, et elle seule', () => {
        const now = 1_000_000;
        for (let i = 0; i < 4; i++) recordFailedAttempt('unlock', 'u1', now);
        assert.doesNotThrow(() => assertAttemptAllowed('unlock', 'u1', now));
        recordFailedAttempt('unlock', 'u1', now);
        assert.throws(
            () => assertAttemptAllowed('unlock', 'u1', now + 1000),
            (e: unknown) => e instanceof LockedOutError && e.retryAfterMs === 29_000
        );
        assert.doesNotThrow(() => assertAttemptAllowed('unlock', 'u2', now + 1000));
        assert.doesNotThrow(() => assertAttemptAllowed('login', 'u1', now + 1000), 'un autre périmètre est à part');
        assert.doesNotThrow(() => assertAttemptAllowed('unlock', 'u1', now + 30_001));
        clearAttempts('unlock', 'u1');
    });

    it('un succès efface l’ardoise', () => {
        for (let i = 0; i < 9; i++) recordFailedAttempt('twofa', 'u3', 0);
        clearAttempts('twofa', 'u3');
        assert.equal(recordFailedAttempt('twofa', 'u3', 0), 1);
        clearAttempts('twofa', 'u3');
    });

    it('le balayage oublie une entrée inactive, pas une entrée verrouillée', () => {
        recordFailedAttempt('recover', 'idle', 0);
        for (let i = 0; i < 20; i++) recordFailedAttempt('recover', 'locked', 3_000_000);
        sweepAttemptsForTest(3_600_001);
        assert.equal(recordFailedAttempt('recover', 'idle', 3_600_002), 1, 'repart de zéro');
        assert.throws(() => assertAttemptAllowed('recover', 'locked', 3_600_001), LockedOutError);
        clearAttempts('recover', 'idle');
        clearAttempts('recover', 'locked');
    });
});
