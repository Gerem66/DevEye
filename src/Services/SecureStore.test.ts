import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import Encryption from './Encryption';
import {
    DEK_ABSOLUTE_TTL_MS,
    DEK_HOLD_MAX_MS,
    forgetSessionDek,
    forgetSessionsOf,
    holdSessionDek,
    peekDekExpiry,
    rememberSessionDek,
    stashPendingDek,
    claimPendingDek,
    claimExportCipher,
    discardExportDek,
    lendExportDek,
    sweepSessionDeksForTest,
    touchSessionDek
} from './SecureStore';

const SESSIONS = ['s1', 's2', 's3'];
const realNow = Date.now;

afterEach(() => {
    Date.now = realNow;
    for (const s of SESSIONS) forgetSessionDek(s);
});

function at(ms: number): void {
    Date.now = () => ms;
}

describe('le cache de DEK par session', () => {
    it('le balayage efface une entrée expirée que plus aucune socket ne lit', () => {
        at(1_000_000);
        const dek = Buffer.alloc(32, 7);
        rememberSessionDek('s1', 1, dek, 10_000);
        assert.notEqual(peekDekExpiry('s1'), null);
        // Personne ne relit s1 : seule la passe de balayage peut l'effacer.
        sweepSessionDeksForTest(1_000_000 + 10_001);
        assert.ok(
            dek.every((b) => b === 0),
            'le matériel de clé est effacé'
        );
        at(1_000_000 + 10_002);
        assert.equal(peekDekExpiry('s1'), null);
    });

    it('le balayage efface aussi une DEK mise de côté pour un challenge 2FA abandonné', () => {
        at(2_000_000);
        const dek = Buffer.alloc(32, 9);
        const token = stashPendingDek(42, dek, 60_000);
        sweepSessionDeksForTest(2_000_000 + 5 * 60_000 + 1);
        assert.ok(dek.every((b) => b === 0));
        assert.equal(claimPendingDek(token), null);
    });

    it('forgetSessionsOf efface toutes les sessions du compte sauf celle gardée', () => {
        at(3_000_000);
        const a = Buffer.alloc(32, 1);
        const b = Buffer.alloc(32, 2);
        const other = Buffer.alloc(32, 3);
        rememberSessionDek('s1', 1, a, 60_000);
        rememberSessionDek('s2', 1, b, 60_000);
        rememberSessionDek('s3', 2, other, 60_000);
        forgetSessionsOf(1, 's2');
        assert.equal(peekDekExpiry('s1'), null);
        assert.notEqual(peekDekExpiry('s2'), null);
        assert.notEqual(peekDekExpiry('s3'), null, 'un autre compte n’est pas touché');
        assert.ok(a.every((x) => x === 0));
    });

    it('un hold ne retient pas la DEK au-delà de DEK_HOLD_MAX_MS', () => {
        const start = 4_000_000;
        at(start);
        rememberSessionDek('s1', 1, Buffer.alloc(32, 5), 60_000);
        // Un battement toutes les 10 s, comme le client, pendant 2 h et 5 min.
        for (let t = 0; t <= DEK_HOLD_MAX_MS + 5 * 60_000; t += 10_000) {
            at(start + t);
            holdSessionDek('s1', true, 60_000);
        }
        at(start + DEK_HOLD_MAX_MS + 5 * 60_000 + 1);
        assert.equal(peekDekExpiry('s1'), null, 'le hold a cessé de renouveler : la grâce a couru puis expiré');
    });

    it('aucun glissement ne dépasse le plafond absolu', () => {
        const start = 5_000_000;
        at(start);
        rememberSessionDek('s1', 1, Buffer.alloc(32, 6), 12 * 3_600_000);
        // Une session active toute la journée : chaque accès glisse la fenêtre.
        for (const hours of [6, 12, 18]) {
            at(start + hours * 3_600_000);
            touchSessionDek('s1');
        }
        at(start + DEK_ABSOLUTE_TTL_MS - 1000);
        touchSessionDek('s1');
        assert.equal(peekDekExpiry('s1'), start + DEK_ABSOLUTE_TTL_MS);
        at(start + DEK_ABSOLUTE_TTL_MS + 1);
        assert.equal(peekDekExpiry('s1'), null);
    });
});

describe('Encryption.encryptWithKey', () => {
    it('refuse une clé effacée plutôt que de sceller sous des zéros', () => {
        assert.throws(() => Encryption.encryptWithKey(Buffer.alloc(32), 'x'), /wiped/);
        assert.throws(() => Encryption.decryptWithKeyRaw(Buffer.alloc(32), 'AAAA'), /wiped/);
    });
});

describe('la clé prêtée à un export', () => {
    it('se retire une fois, pour ce compte seulement, et s’efface à la fin', async () => {
        const dek = Buffer.alloc(32, 9);
        const token = lendExportDek(7, dek);
        assert.equal(claimExportCipher(token, 8), null, 'un autre compte n’y touche pas');

        const other = lendExportDek(7, dek);
        const lent = claimExportCipher(other, 7);
        assert.ok(lent);
        assert.equal(claimExportCipher(other, 7), null, 'une seule fois');
        const blob = await lent.cipher.encrypt('coffre');
        assert.equal(await lent.cipher.decrypt(blob), 'coffre');
        lent.release();
        await assert.rejects(lent.cipher.decrypt(blob), { code: 'locked' });
        assert.ok(
            dek.every((b) => b === 9),
            'le prêt est une copie'
        );
    });

    it('meurt au bout de cinq minutes sans avoir servi', () => {
        at(2_000_000);
        const token = lendExportDek(7, Buffer.alloc(32, 1));
        at(2_000_000 + 5 * 60_000);
        assert.equal(claimExportCipher(token, 7), null);
    });

    it('se révoque avec les sessions du compte, même retirée', async () => {
        const lent = claimExportCipher(lendExportDek(7, Buffer.alloc(32, 2)), 7);
        assert.ok(lent);
        forgetSessionsOf(7);
        await assert.rejects(lent.cipher.encrypt('x'), { code: 'locked' });
        const discarded = lendExportDek(7, Buffer.alloc(32, 3));
        discardExportDek(discarded);
        assert.equal(claimExportCipher(discarded, 7), null);
    });
});
