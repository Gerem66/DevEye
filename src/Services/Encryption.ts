import crypto from 'crypto';

/**
 * Symmetric encryption helper.
 *
 * Two layers coexist:
 *
 *  1. Legacy `Encrypt`/`Decrypt` — keyed by the instance's `keyA`/`keyB`
 *     (the server key from env). Kept byte-compatible so data written before
 *     envelope encryption keeps decrypting. Still used for auth-bound secrets
 *     that must be readable without a live user password (e.g. the 2FA secret).
 *
 *  2. `encryptWithKey`/`decryptWithKey` — AES-256-GCM keyed by an explicit
 *     32-byte key. This is the primitive the envelope scheme is built on: it
 *     encrypts feature data with the per-user DEK and wraps the DEK with the
 *     server key or a password-derived key.
 */
class Encryption {
    keyA: string;
    keyB: string;
    cipher_algo: string;

    constructor(key: string, secondKey: string) {
        this.keyA = key;
        this.keyB = secondKey;
        this.cipher_algo = 'aes-256-ctr';
    }

    defineSecondKey(secondKey: string) {
        this.keyB = secondKey;
    }

    static hashPassword(password: string) {
        if (password.length === 0) {
            return '';
        }
        return crypto.createHash('sha512').update(password).digest('hex');
    }

    /** 32-byte key derived from the server key, used to wrap a DEK at rest. */
    serverKey(): Buffer {
        return crypto.createHash('sha256').update(`${this.keyA}:${this.keyB}`).digest();
    }

    Encrypt(plaintext: string) {
        const nonce = crypto.randomBytes(16);
        const cipher = crypto.createCipheriv(this.cipher_algo, this.keyA, nonce);
        const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
        const keyB = crypto.createHash('ripemd160').update(this.keyB).digest();
        const mac = crypto
            .createHmac('sha512', keyB)
            .update(Buffer.concat([nonce, ciphertext]))
            .digest();
        return Buffer.concat([mac, nonce, ciphertext]).toString('base64');
    }

    Decrypt(message: string): string | null {
        const decoded = Buffer.from(message, 'base64');
        if (decoded.length < 80) return null;

        const mac = decoded.subarray(0, 64);
        const nonce = decoded.subarray(64, 80);
        const ciphertext = decoded.subarray(80);

        const keyB = crypto.createHash('ripemd160').update(this.keyB).digest();
        const calc = crypto
            .createHmac('sha512', keyB)
            .update(Buffer.concat([nonce, ciphertext]))
            .digest();

        if (calc.length !== mac.length || !crypto.timingSafeEqual(calc, mac)) {
            return null;
        }

        try {
            const decipher = crypto.createDecipheriv(this.cipher_algo, this.keyA, nonce);
            const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
            return plaintext.toString('utf8');
        } catch {
            return null;
        }
    }

    /**
     * AES-256-GCM encrypt `plaintext` (string or raw bytes) under a 32-byte
     * `key`. Output is base64 of `iv(12) | tag(16) | ciphertext`.
     */
    static encryptWithKey(key: Buffer, plaintext: string | Buffer): string {
        if (key.length !== 32) throw new Error('encryptWithKey: key must be 32 bytes');
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
        const data = typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : plaintext;
        const ciphertext = Buffer.concat([cipher.update(data), cipher.final()]);
        const tag = cipher.getAuthTag();
        return Buffer.concat([iv, tag, ciphertext]).toString('base64');
    }

    /**
     * Inverse of {@link encryptWithKey}, returning raw bytes. Returns `null`
     * when the key is wrong or the data is tampered (GCM auth failure).
     */
    static decryptWithKeyRaw(key: Buffer, message: string): Buffer | null {
        if (key.length !== 32) throw new Error('decryptWithKey: key must be 32 bytes');
        const decoded = Buffer.from(message, 'base64');
        if (decoded.length < 28) return null;
        const iv = decoded.subarray(0, 12);
        const tag = decoded.subarray(12, 28);
        const ciphertext = decoded.subarray(28);
        try {
            const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
            decipher.setAuthTag(tag);
            return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
        } catch {
            return null;
        }
    }

    /** UTF-8 string variant of {@link decryptWithKeyRaw}. */
    static decryptWithKey(key: Buffer, message: string): string | null {
        const raw = Encryption.decryptWithKeyRaw(key, message);
        return raw === null ? null : raw.toString('utf8');
    }
}

export default Encryption;
