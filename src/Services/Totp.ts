import crypto from 'crypto';

import { env } from '@/Utils/Env';

/**
 * Self-contained TOTP (RFC 6238) + recovery-code helpers, implemented on Node's
 * crypto to avoid an external dependency. Secrets are base32 (RFC 4648), 20 raw
 * bytes; verification allows a +/- 1 step (30s) window for clock drift.
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

export function verifyTotp(token: string, secret: string): boolean {
    const normalized = token.replace(/\s+/g, '');
    if (!/^\d{6}$/.test(normalized)) return false;
    const key = base32Decode(secret);
    if (key.length === 0) return false;
    const counter = Math.floor(Date.now() / 1000 / STEP_SECONDS);
    for (let drift = -1; drift <= 1; drift++) {
        const candidate = hotp(key, counter + drift);
        if (crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(normalized))) {
            return true;
        }
    }
    return false;
}

/** Generate N human-friendly recovery codes (formatted XXXX-XXXX). */
export function generateBackupCodes(count = 10): string[] {
    const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    const codes: string[] = [];
    for (let i = 0; i < count; i++) {
        let raw = '';
        for (let j = 0; j < 8; j++) {
            raw += alphabet[crypto.randomInt(alphabet.length)];
        }
        codes.push(`${raw.slice(0, 4)}-${raw.slice(4)}`);
    }
    return codes;
}

/** Normalize a user-entered backup code for hashing/comparison. */
export function normalizeBackupCode(code: string): string {
    return code.trim().toUpperCase().replace(/\s+/g, '');
}
