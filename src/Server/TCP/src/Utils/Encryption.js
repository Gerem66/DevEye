import crypto from 'crypto';

class Encryption {
    /**
     * @param {string} key
     * @param {string} secondKey
     */
    constructor(key, secondKey) {
        this.keyA = key;
        this.keyB = secondKey;
        this.cipher_algo = 'aes-256-ctr';
    }

    /** @param {string} secondKey */
    defineSecondKey(secondKey) {
        this.keyB = secondKey;
    }

    /** @param {string} password */
    static hashPassword(password) {
        if (password.length === 0) {
            return '';
        }
        return crypto.createHash('sha512').update(password).digest('hex');
    }

    /** @param {string} plaintext */
    Encrypt(plaintext) {
        const nonce = crypto.randomBytes(16);
        const cipher = crypto.createCipheriv(this.cipher_algo, this.keyA, nonce);
        const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
        const keyB = crypto.createHash('ripemd160').update(this.keyB).digest();
        const mac = crypto.createHmac('sha512', keyB).update(Buffer.concat([nonce, ciphertext])).digest();
        return Buffer.concat([mac, nonce, ciphertext]).toString('base64');
    }

    /** @param {string} message */
    Decrypt(message) {
        const decoded = Buffer.from(message, 'base64');
        //const mac = decoded.subarray(0, 64);
        const nonce = decoded.subarray(64, 80);
        const ciphertext = decoded.subarray(80);
        //const keyB = crypto.createHash('ripemd160').update(this.keyB).digest();
        //const calc = crypto.createHmac('sha512', keyB).update(Buffer.concat([nonce, ciphertext])).digest();

        // Disabled for now to decrypt old data
        //if (!crypto.timingSafeEqual(calc, mac)) {
        //if (calc.toString() !== mac.toString()) {
        //    return null;
        //}

        const decipher = crypto.createDecipheriv(this.cipher_algo, this.keyA, nonce);
        const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
        return plaintext.toString('utf8');
    }
}

export default Encryption;
