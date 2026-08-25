import crypto from 'crypto';

/**
 * Le chiffrement symétrique de DevEye : AES-256-GCM, une seule primitive, un
 * seul format de blob (base64 de `iv(12) | tag(16) | chiffré`).
 *
 *  - `encryptWithKey` / `decryptWithKey(Raw)` : sous une clé explicite de 32
 *    octets. C'est la brique du chiffrement par enveloppe : les données de
 *    features sous une DEK (ou la WDK d'un espace), et l'emballage de ces DEK.
 *  - `seal` / `open(Raw)` : sous la **clé serveur**, dérivée de l'env
 *    (`sha256("CRYPT_KEY_A:CRYPT_KEY_B")`). Réservé à ce qui doit se relire
 *    sans aucune session : l'emballage des DEK, le secret TOTP, le matériel de
 *    clé des modules (`deps.keys`). Jamais des données d'utilisateur, qui
 *    passent par `ctx.secure`.
 */
class Encryption {
    private readonly key: Buffer;

    constructor(keyA: string, keyB: string) {
        this.key = crypto.createHash('sha256').update(`${keyA}:${keyB}`).digest();
    }

    /** La clé serveur, 32 octets : pour en dériver d'autres (sauvegardes). */
    serverKey(): Buffer {
        return this.key;
    }

    /** Scelle sous la clé serveur. */
    seal(plaintext: string | Buffer): string {
        return Encryption.encryptWithKey(this.key, plaintext);
    }

    /** Inverse de {@link seal}, en octets ; `null` si le blob n'est pas à nous. */
    openRaw(sealed: string): Buffer | null {
        return Encryption.decryptWithKeyRaw(this.key, sealed);
    }

    /** Inverse de {@link seal}, en UTF-8 ; `null` si le blob n'est pas à nous. */
    open(sealed: string): string | null {
        return Encryption.decryptWithKey(this.key, sealed);
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
