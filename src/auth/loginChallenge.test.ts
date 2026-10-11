import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import Encryption from '@/Services/Encryption';
import {
    abandonLoginChallengesOf,
    advanceLoginChallenge,
    completeLoginChallenge,
    findLoginChallenge,
    issueLoginCode,
    LOGIN_CODE_TTL_MS,
    matchesLoginCode,
    openLoginChallenge
} from './loginChallenge';

const crypt = new Encryption('a'.repeat(32), 'b'.repeat(32));

describe('loginChallenge', () => {
    it('un code envoyé ne vaut que lui, et seulement dix minutes', () => {
        const challenge = openLoginChallenge(1, ['email', 'totp']);
        const code = issueLoginCode(crypt, challenge, 1_000);
        assert.match(code, /^\d{6}$/);
        assert.ok(matchesLoginCode(crypt, challenge, code, 2_000));
        assert.ok(!matchesLoginCode(crypt, challenge, code === '000000' ? '111111' : '000000', 2_000));
        assert.ok(!matchesLoginCode(crypt, challenge, code, 1_000 + LOGIN_CODE_TTL_MS));
        completeLoginChallenge(challenge);
    });

    it('un code redemandé remplace le précédent', () => {
        const challenge = openLoginChallenge(2, ['email']);
        const first = issueLoginCode(crypt, challenge, 1_000);
        let second = issueLoginCode(crypt, challenge, 2_000);
        // Six chiffres au hasard peuvent se répéter : on tire jusqu'à en avoir un autre.
        while (second === first) second = issueLoginCode(crypt, challenge, 2_000);
        assert.ok(!matchesLoginCode(crypt, challenge, first, 3_000));
        assert.ok(matchesLoginCode(crypt, challenge, second, 3_000));
        assert.equal(challenge.sends >= 2, true);
        completeLoginChallenge(challenge);
    });

    it('franchir une étape efface son code et retient ce qui a été prouvé', () => {
        const challenge = openLoginChallenge(3, ['email', 'totp', 'sms']);
        issueLoginCode(crypt, challenge);
        advanceLoginChallenge(challenge);
        assert.deepEqual(challenge.steps, ['totp', 'sms']);
        assert.equal(challenge.code, null);
        assert.equal(challenge.sends, 0);
        advanceLoginChallenge(challenge, false);
        assert.deepEqual(challenge.passed, ['email']);
        completeLoginChallenge(challenge);
    });

    it('ne se retrouve que pour son compte, et plus après abandon', () => {
        const challenge = openLoginChallenge(4, ['totp']);
        assert.equal(findLoginChallenge(challenge.id, 5), null);
        assert.equal(findLoginChallenge(challenge.id, 4), challenge);
        abandonLoginChallengesOf(4);
        assert.equal(findLoginChallenge(challenge.id, 4), null);
    });

    it('cinq connexions en cours par compte au plus : la plus ancienne cède', () => {
        const opened = Array.from({ length: 6 }, () => openLoginChallenge(6, ['email']));
        assert.equal(findLoginChallenge(opened[0].id, 6), null);
        for (const challenge of opened.slice(1)) assert.equal(findLoginChallenge(challenge.id, 6), challenge);
        abandonLoginChallengesOf(6);
    });
});
