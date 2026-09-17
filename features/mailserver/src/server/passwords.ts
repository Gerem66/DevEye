import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt) as (
    password: string,
    salt: Buffer,
    keylen: number,
    options: crypto.ScryptOptions
) => Promise<Buffer>;

/** N = 2^15 : environ 60 ms par essai, et 32 Mio, ce qui borne aussi les essais de front. */
const COST = { N: 32_768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEY_BYTES = 32;

/** `scrypt$<sel>$<clé>`, en base64url. Le coût n'y figure pas : il ne change qu'avec le préfixe. */
export async function hashSecret(secret: string): Promise<string> {
    const salt = crypto.randomBytes(16);
    const key = await scrypt(secret, salt, KEY_BYTES, COST);
    return `scrypt$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export async function verifySecret(secret: string, stored: string): Promise<boolean> {
    const [scheme, salt, key] = stored.split('$');
    if (scheme !== 'scrypt' || !salt || !key) return false;
    const expected = Buffer.from(key, 'base64url');
    const actual = await scrypt(secret, Buffer.from(salt, 'base64url'), expected.length, COST);
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

/** Sans 0, O, 1, l ni I : un mot de passe recopié à la main d'un écran à un téléphone. */
const ALPHABET = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** 24 caractères, soit environ 140 bits : affiché une fois, jamais conservé en clair. */
export function generateSecret(length = 24): string {
    let out = '';
    while (out.length < length) {
        // Le rejet garde la distribution uniforme : 256 n'est pas un multiple de 57.
        for (const byte of crypto.randomBytes(length)) {
            if (byte < ALPHABET.length * 4 && out.length < length) out += ALPHABET[byte % ALPHABET.length];
        }
    }
    return out;
}
