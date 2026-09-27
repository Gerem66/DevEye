import crypto from 'crypto';

import { env } from '@/Utils/Env';
import type Encryption from './Encryption';

/**
 * Self-contained TOTP (RFC 6238) + recovery-code helpers, implemented on Node's
 * crypto to avoid an external dependency. Secrets are base32 (RFC 4648), 20 raw
 * bytes; verification allows the current step and the previous one (30s) for
 * clock drift, never a future one, and a step once accepted is never accepted
 * again (the caller stores it: {@link verifyTotp} returns the matched counter).
 */

const STEP_SECONDS = 30;
const DIGITS = 6;
const ALGORITHM = 'sha1';
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf: Buffer): string {
    let bits = 0;
    let value = 0;
    let output = '';
    for (const byte of buf) {
        value = (value << 8) | byte;
        bits += 8;
        while (bits >= 5) {
            output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
            bits -= 5;
        }
    }
    if (bits > 0) {
        output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
    }
    return output;
}

function base32Decode(input: string): Buffer {
    const clean = input.replace(/=+$/, '').toUpperCase().replace(/\s+/g, '');
    let bits = 0;
    let value = 0;
    const bytes: number[] = [];
    for (const char of clean) {
        const idx = BASE32_ALPHABET.indexOf(char);
        if (idx === -1) continue;
        value = (value << 5) | idx;
        bits += 5;
        if (bits >= 8) {
            bytes.push((value >>> (bits - 8)) & 0xff);
            bits -= 8;
        }
    }
    return Buffer.from(bytes);
}

function hotp(secret: Buffer, counter: number): string {
    const buf = Buffer.alloc(8);
    // Counter < 2^53 fits in the low bytes for any realistic timestamp.
    buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
    buf.writeUInt32BE(counter >>> 0, 4);
    const hmac = crypto.createHmac(ALGORITHM, secret).update(buf).digest();
    const offset = hmac[hmac.length - 1] & 0x0f;
    const code =
        ((hmac[offset] & 0x7f) << 24) |
        ((hmac[offset + 1] & 0xff) << 16) |
        ((hmac[offset + 2] & 0xff) << 8) |
        (hmac[offset + 3] & 0xff);
    return (code % 10 ** DIGITS).toString().padStart(DIGITS, '0');
}

export interface TotpProvisioning {
    secret: string;
    otpauthUrl: string;
}

export function generateTotpSecret(accountName: string): TotpProvisioning {
    const secret = base32Encode(crypto.randomBytes(20));
    const label = encodeURIComponent(`${env.TWOFA_ISSUER}:${accountName}`);
    const params = new URLSearchParams({
        secret,
        issuer: env.TWOFA_ISSUER,
        algorithm: 'SHA1',
        digits: String(DIGITS),
        period: String(STEP_SECONDS)
    });
    return { secret, otpauthUrl: `otpauth://totp/${label}?${params.toString()}` };
}

/**
 * The time step a code matches, or `null`. A step at or before `lastUsedCounter`
 * is refused even if the code is right: a code seen over someone's shoulder is
 * worth nothing once its owner has used it. `now` is injectable for tests.
 */
export function verifyTotp(
    token: string,
    secret: string,
    lastUsedCounter: number | null,
    now: number = Date.now()
): number | null {
    const normalized = token.replace(/\s+/g, '');
    if (!/^\d{6}$/.test(normalized)) return null;
    const key = base32Decode(secret);
    if (key.length === 0) return null;
    const counter = Math.floor(now / 1000 / STEP_SECONDS);
    for (const drift of [0, -1]) {
        const step = counter + drift;
        const candidate = hotp(key, step);
        if (crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(normalized))) {
            return lastUsedCounter !== null && step <= lastUsedCounter ? null : step;
        }
    }
    return null;
}

/** The code an authenticator app shows at `now`: what the end-to-end runner types. */
export function totpCode(secret: string, now: number = Date.now()): string {
    return hotp(base32Decode(secret), Math.floor(now / 1000 / STEP_SECONDS));
}

/** Generate N recovery codes, 16 characters over a 31-symbol alphabet (~79 bits each). */
export function generateBackupCodes(count = 10): string[] {
    const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    const codes: string[] = [];
    for (let i = 0; i < count; i++) {
        const groups: string[] = [];
        for (let g = 0; g < 4; g++) {
            let chunk = '';
            for (let j = 0; j < 4; j++) chunk += alphabet[crypto.randomInt(alphabet.length)];
            groups.push(chunk);
        }
        codes.push(groups.join('-'));
    }
    return codes;
}

/** Normalize a user-entered backup code for hashing/comparison. */
export function normalizeBackupCode(code: string): string {
    return code.trim().toUpperCase().replace(/[\s-]/g, '');
}

/**
 * The stored form of a backup code: an HMAC under a key derived from the server
 * key, not a bare hash. Ten codes of ~79 bits resist guessing on their own; the
 * key is what makes a stolen dump useless for testing candidates offline.
 */
export function hashBackupCode(crypt: Encryption, code: string): string {
    const key = crypt.derive('deveye-backup-codes', 'v1', 32);
    return crypto.createHmac('sha256', key).update(normalizeBackupCode(code)).digest('hex');
}
