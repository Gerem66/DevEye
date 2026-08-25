import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { test } from 'node:test';

import Encryption from '@/Services/Encryption';
import { classifyBlob, decryptLegacy } from './legacy-blob';

const KEY_A = 'a'.repeat(32);
const KEY_B = 'second-key-for-the-mac';

/** L'ancien `Encryption.Encrypt`, recopié ici pour fabriquer des blobs d'époque. */
function encryptLegacy(keyA: string, keyB: string, plaintext: string): string {
    const nonce = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-ctr', keyA, nonce);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const macKey = crypto.createHash('ripemd160').update(keyB).digest();
    const mac = crypto
        .createHmac('sha512', macKey)
        .update(Buffer.concat([nonce, ciphertext]))
        .digest();
    return Buffer.concat([mac, nonce, ciphertext]).toString('base64');
}

test('decryptLegacy relit un blob d’époque, et rien d’autre', () => {
    const blob = encryptLegacy(KEY_A, KEY_B, 'secret d’époque');
    assert.equal(decryptLegacy(KEY_A, KEY_B, blob), 'secret d’époque');
    assert.equal(decryptLegacy(KEY_A, 'autre clé B', blob), null, 'HMAC faux');
    assert.equal(decryptLegacy(KEY_A, KEY_B, 'pas du base64 utile'), null, 'trop court');
    assert.equal(decryptLegacy(KEY_A, KEY_B, ''), null);
});

test('classifyBlob distingue courant, ancien et illisible', () => {
    const key = crypto.randomBytes(32);
    assert.deepEqual(classifyBlob(key, KEY_A, KEY_B, Encryption.encryptWithKey(key, 'déjà à jour')), {
        state: 'current'
    });
    assert.deepEqual(classifyBlob(key, KEY_A, KEY_B, encryptLegacy(KEY_A, KEY_B, 'à convertir')), {
        state: 'legacy',
        plaintext: 'à convertir'
    });
    const other = crypto.randomBytes(32);
    assert.deepEqual(classifyBlob(key, KEY_A, KEY_B, Encryption.encryptWithKey(other, 'sous une autre clé')), {
        state: 'unreadable'
    });
    assert.deepEqual(classifyBlob(key, KEY_A, KEY_B, 'n’importe quoi'), { state: 'unreadable' });
    // Sans clé courante (compte sans DEK), seul l'ancien format peut se lire.
    assert.equal(classifyBlob(null, KEY_A, KEY_B, encryptLegacy(KEY_A, KEY_B, 'x')).state, 'legacy');
    assert.equal(classifyBlob(null, KEY_A, KEY_B, Encryption.encryptWithKey(key, 'x')).state, 'unreadable');
});

test('un blob scellé sous la clé serveur est courant pour cette clé seulement', () => {
    const crypt = new Encryption(KEY_A, KEY_B);
    const sealed = crypt.seal('secret TOTP');
    assert.equal(classifyBlob(crypt.serverKey(), KEY_A, KEY_B, sealed).state, 'current');
    assert.equal(classifyBlob(crypto.randomBytes(32), KEY_A, KEY_B, sealed).state, 'unreadable');
    assert.equal(crypt.open(sealed), 'secret TOTP');
});
