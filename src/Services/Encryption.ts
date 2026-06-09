import crypto from 'crypto';

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
}

export default Encryption;
