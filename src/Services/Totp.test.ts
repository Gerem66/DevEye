import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { describe, it } from 'node:test';

import Encryption from './Encryption';
import {
    generateBackupCodes,
    generateTotpSecret,
    hashBackupCode,
    normalizeBackupCode,
    totpCode,
    verifyTotp
} from './Totp';

/** Le code attendu pour un pas donné, refait ici pour ne pas dépendre de l'horloge. */
function codeAt(secretBase32: string, step: number): string {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let bits = 0;
    let value = 0;
    const bytes: number[] = [];
    for (const ch of secretBase32) {
        value = (value << 5) | alphabet.indexOf(ch);
        bits += 5;
        if (bits >= 8) {
            bytes.push((value >>> (bits - 8)) & 0xff);
            bits -= 8;
        }
    }
    const buf = Buffer.alloc(8);
    buf.writeUInt32BE(Math.floor(step / 0x100000000), 0);
    buf.writeUInt32BE(step >>> 0, 4);
    const hmac = crypto.createHmac('sha1', Buffer.from(bytes)).update(buf).digest();
    const offset = hmac[hmac.length - 1] & 0x0f;
    const code = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
    return (code % 1_000_000).toString().padStart(6, '0');
}

describe('verifyTotp', () => {
    const { secret } = generateTotpSecret('test@example.com');
    const now = 1_700_000_000_000;
    const step = Math.floor(now / 1000 / 30);

    it('accepte le pas courant et le précédent, jamais le suivant', () => {
        assert.equal(verifyTotp(codeAt(secret, step), secret, null, now), step);
        assert.equal(verifyTotp(codeAt(secret, step - 1), secret, null, now), step - 1);
        assert.equal(verifyTotp(codeAt(secret, step + 1), secret, null, now), null);
    });

    it('refuse un pas déjà utilisé, même avec le bon code', () => {
        assert.equal(verifyTotp(codeAt(secret, step), secret, step, now), null);
        assert.equal(verifyTotp(codeAt(secret, step - 1), secret, step, now), null);
        assert.equal(verifyTotp(codeAt(secret, step), secret, step - 1, now), step);
    });

    it('refuse ce qui n’est pas six chiffres', () => {
        assert.equal(verifyTotp('12345', secret, null, now), null);
        assert.equal(verifyTotp('abcdef', secret, null, now), null);
    });
});

describe('les codes de secours', () => {
    it('font 16 caractères en quatre groupes', () => {
        for (const code of generateBackupCodes()) assert.match(code, /^[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/);
    });

    it('se normalisent sans tirets, espaces ni casse', () => {
        assert.equal(normalizeBackupCode(' abcd-efgh jklm-npqr '), 'ABCDEFGHJKLMNPQR');
    });

    it('sont condensés sous une clé : deux clés serveur, deux condensés', () => {
        const a = new Encryption('a'.repeat(32), 'b'.repeat(32));
        const b = new Encryption('c'.repeat(32), 'd'.repeat(32));
        assert.equal(hashBackupCode(a, 'ABCD-EFGH-JKLM-NPQR'), hashBackupCode(a, 'abcdefghjklmnpqr'));
        assert.notEqual(hashBackupCode(a, 'ABCD-EFGH-JKLM-NPQR'), hashBackupCode(b, 'ABCD-EFGH-JKLM-NPQR'));
    });
});

describe('totpCode', () => {
    it('rend le code qu’une application afficherait, accepté une fois', () => {
        const { secret } = generateTotpSecret('essai');
        const now = 1_790_000_000_000;
        const code = totpCode(secret, now);
        const step = verifyTotp(code, secret, null, now);
        assert.equal(step, Math.floor(now / 30_000));
        assert.equal(verifyTotp(code, secret, step, now), null);
    });
});
