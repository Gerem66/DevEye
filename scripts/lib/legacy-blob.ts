import crypto from 'node:crypto';

import Encryption from '@/Services/Encryption';

/**
 * L'ancien format de blob de DevEye (2024 → juin 2026) : AES-256-CTR sous
 * `CRYPT_KEY_A` prise telle quelle comme clé, HMAC-SHA512 sous
 * ripemd160(`CRYPT_KEY_B`), base64 de `mac(64) | nonce(16) | chiffré`.
 *
 * Il ne vit plus qu'ici, pour le re-chiffrement une fois pour toutes
 * (`scripts/reencrypt-legacy-blobs.ts`) : rien dans l'application ne le lit ni
 * ne l'écrit plus. Le script parti, ce fichier part avec lui.
 */
export function decryptLegacy(keyA: string, keyB: string, blob: string): string | null {
    const decoded = Buffer.from(blob, 'base64');
    if (decoded.length < 80) return null;
    const mac = decoded.subarray(0, 64);
    const nonce = decoded.subarray(64, 80);
    const ciphertext = decoded.subarray(80);
    const macKey = crypto.createHash('ripemd160').update(keyB).digest();
    const expected = crypto
        .createHmac('sha512', macKey)
        .update(Buffer.concat([nonce, ciphertext]))
        .digest();
    if (expected.length !== mac.length || !crypto.timingSafeEqual(expected, mac)) return null;
    try {
        const decipher = crypto.createDecipheriv('aes-256-ctr', keyA, nonce);
        return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    } catch {
        return null;
    }
}

export type BlobState = { state: 'current' } | { state: 'legacy'; plaintext: string } | { state: 'unreadable' };

/**
 * Ce qu'est un blob face à la clé qui doit le lire : déjà au format courant,
 * à convertir (ancien format, clair en main), ou illisible sous les deux.
 * `key: null` = cette clé n'existe pas encore (compte sans DEK), donc le blob
 * ne peut pas être au format courant.
 */
export function classifyBlob(key: Buffer | null, keyA: string, keyB: string, blob: string): BlobState {
    if (key !== null && Encryption.decryptWithKeyRaw(key, blob) !== null) return { state: 'current' };
    const plaintext = decryptLegacy(keyA, keyB, blob);
    return plaintext === null ? { state: 'unreadable' } : { state: 'legacy', plaintext };
}
