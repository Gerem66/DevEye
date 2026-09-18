import crypto from 'crypto';

/**
 * Ce que la clé serveur scelle, chacun sous sa propre sous-clé (HKDF de la
 * racine, étiquette en `info`) : un blob scellé pour un usage ne s'ouvre pas
 * pour un autre, même copié dans la bonne colonne. Un module scelle sous
 * `module:<id>`, dérivé de la même façon.
 */
export type SealLabel = 'user-dek' | 'user-open-dek' | 'workspace-dek' | 'totp' | `module:${string}`;

/** Premier octet d'un blob scellé sous la clé serveur. */
export const SEAL_VERSION = 0x02;

const HKDF_SALT = 'deveye-seal';

/**
 * Le chiffrement symétrique de DevEye : AES-256-GCM, une seule primitive, deux
 * formats de blob.
 *
 *  - `encryptWithKey` / `decryptWithKey(Raw)` : sous une clé explicite de 32
 *    octets, base64 de `iv(12) | tag(16) | chiffré`. C'est la brique du
 *    chiffrement par enveloppe : les données de features sous une DEK (ou la
 *    WDK d'un espace), et l'emballage de ces DEK par une clé dérivée du mot de
 *    passe.
 *  - `sealFor` / `openFor` : sous la **clé serveur**, dont la racine est
 *    `sha256("CRYPT_KEY_A:CRYPT_KEY_B")` (ce que `scripts/restore-backup.mjs`
 *    refait sans DevEye : la racine ne change pas). Base64 de
 *    `0x02 | iv(12) | tag(16) | chiffré`, sous la sous-clé de l'étiquette, avec
 *    un contexte en AAD qui lie le blob à sa ligne. Réservé à ce qui doit se
 *    relire sans aucune session : l'emballage des DEK, le secret TOTP, le
 *    matériel de clé des modules (`deps.keys`). Jamais des données
 *    d'utilisateur, qui passent par `ctx.secure`.
 */
class Encryption {
    private readonly root: Buffer;
    private readonly subkeys = new Map<string, Buffer>();

    constructor(keyA: string, keyB: string) {
        this.root = Encryption.legacyServerKey(keyA, keyB);
    }

    /**
     * La clé serveur d'avant les étiquettes : ce sous quoi `seal` scellait tout.
     * Ne sert qu'au script qui re-scelle une base au format 2.
     */
    static legacyServerKey(keyA: string, keyB: string): Buffer {
        return crypto.createHash('sha256').update(`${keyA}:${keyB}`).digest();
    }

    private keyFor(label: SealLabel): Buffer {
        let key = this.subkeys.get(label);
        if (!key) {
            key = Buffer.from(crypto.hkdfSync('sha256', this.root, HKDF_SALT, label, 32));
            this.subkeys.set(label, key);
        }
        return key;
    }

    /**
     * Une clé dérivée de la racine pour un usage à part (les archives de
     * sauvegarde). La racine elle-même ne sort jamais.
     */
    derive(salt: string, info: string, length: number): Buffer {
        return Buffer.from(crypto.hkdfSync('sha256', this.root, Buffer.from(salt), Buffer.from(info), length));
    }

    /** Scelle sous la sous-clé de l'étiquette, le contexte en AAD. */
    sealFor(label: SealLabel, plaintext: string | Buffer, context: string): string {
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', this.keyFor(label), iv);
        cipher.setAAD(Buffer.from(context, 'utf8'));
        const data = typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : plaintext;
        const ciphertext = Buffer.concat([cipher.update(data), cipher.final()]);
        const tag = cipher.getAuthTag();
        return Buffer.concat([Buffer.from([SEAL_VERSION]), iv, tag, ciphertext]).toString('base64');
    }

    /**
     * Inverse de {@link sealFor}, en octets ; `null` si le blob n'est pas au
     * format 2, n'est pas de cette étiquette, ou n'appartient pas à ce contexte.
     */
    openFor(label: SealLabel, sealed: string, context: string): Buffer | null {
        const decoded = Buffer.from(sealed, 'base64');
        if (decoded.length < 29 || decoded[0] !== SEAL_VERSION) return null;
        const iv = decoded.subarray(1, 13);
        const tag = decoded.subarray(13, 29);
        const ciphertext = decoded.subarray(29);
        try {
            const decipher = crypto.createDecipheriv('aes-256-gcm', this.keyFor(label), iv);
            decipher.setAAD(Buffer.from(context, 'utf8'));
            decipher.setAuthTag(tag);
            return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
        } catch {
            return null;
        }
    }

    /** Inverse de {@link sealFor}, en UTF-8. */
    openTextFor(label: SealLabel, sealed: string, context: string): string | null {
        const raw = this.openFor(label, sealed, context);
        return raw === null ? null : raw.toString('utf8');
    }

    /**
     * AES-256-GCM encrypt `plaintext` (string or raw bytes) under a 32-byte
     * `key`. Output is base64 of `iv(12) | tag(16) | ciphertext`. A wiped key
     * (all zero) is refused: it would seal content nobody can open again.
     */
    static encryptWithKey(key: Buffer, plaintext: string | Buffer): string {
        assertUsableKey(key, 'encryptWithKey');
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
        assertUsableKey(key, 'decryptWithKey');
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

function assertUsableKey(key: Buffer, where: string): void {
    if (key.length !== 32) throw new Error(`${where}: key must be 32 bytes`);
    if (key.every((b) => b === 0)) throw new Error(`${where}: key material has been wiped`);
}

export default Encryption;
