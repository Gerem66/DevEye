/**
 * One-off re-encryption migration for passwords stored with the old WebCrypto
 * HMAC format (raw keyB bytes) introduced by Crypt.js (pre-March 2024).
 *
 * The new Encryption.ts uses ripemd160(keyB) as the HMAC key, which breaks
 * any row whose MAC was computed with the old raw-keyB method.
 *
 * Strategy per row:
 *   1. Try new decrypt (ripemd160 HMAC)  → already fine, skip.
 *   2. Try old decrypt (raw keyB HMAC)   → migrate: re-encrypt and UPDATE.
 *   3. Both fail                          → log as unrecoverable, skip.
 *
 * Run once with: node scripts/reencrypt-legacy-passwords.mjs
 */

import 'dotenv/config';
import crypto from 'crypto';
import mysql from 'mysql2/promise';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CIPHER = 'aes-256-ctr';

/** New decrypt: HMAC key = ripemd160(keyB) */
function decryptNew(keyA, keyB, message) {
    const decoded = Buffer.from(message, 'base64');
    if (decoded.length < 80) return null;

    const mac = decoded.subarray(0, 64);
    const nonce = decoded.subarray(64, 80);
    const ciphertext = decoded.subarray(80);

    const derivedKey = crypto.createHash('ripemd160').update(keyB).digest();
    const calc = crypto
        .createHmac('sha512', derivedKey)
        .update(Buffer.concat([nonce, ciphertext]))
        .digest();

    if (calc.length !== mac.length || !crypto.timingSafeEqual(calc, mac)) return null;

    try {
        const decipher = crypto.createDecipheriv(CIPHER, keyA, nonce);
        return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    } catch {
        return null;
    }
}

/** Old decrypt: HMAC key = raw bytes of keyB (WebCrypto Crypt.js era) */
function decryptOld(keyA, keyB, message) {
    const decoded = Buffer.from(message, 'base64');
    if (decoded.length < 80) return null;

    const mac = decoded.subarray(0, 64);
    const nonce = decoded.subarray(64, 80);
    const ciphertext = decoded.subarray(80);

    const rawKey = Buffer.from(keyB, 'utf8');
    const calc = crypto
        .createHmac('sha512', rawKey)
        .update(Buffer.concat([nonce, ciphertext]))
        .digest();

    if (calc.length !== mac.length || !crypto.timingSafeEqual(calc, mac)) return null;

    try {
        const decipher = crypto.createDecipheriv(CIPHER, keyA, nonce);
        return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    } catch {
        return null;
    }
}

/** New encrypt: same as current Encryption.ts */
function encryptNew(keyA, keyB, plaintext) {
    const nonce = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(CIPHER, keyA, nonce);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const derivedKey = crypto.createHash('ripemd160').update(keyB).digest();
    const mac = crypto
        .createHmac('sha512', derivedKey)
        .update(Buffer.concat([nonce, ciphertext]))
        .digest();
    return Buffer.concat([mac, nonce, ciphertext]).toString('base64');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const keyA = process.env.CRYPT_KEY_A;
const keyB = process.env.CRYPT_KEY_B;

if (!keyA || !keyB) {
    console.error('Missing CRYPT_KEY_A or CRYPT_KEY_B in environment.');
    process.exit(1);
}
if (Buffer.byteLength(keyA, 'utf8') !== 32) {
    console.error(`CRYPT_KEY_A must be exactly 32 bytes (got ${Buffer.byteLength(keyA, 'utf8')}).`);
    process.exit(1);
}

// Print partial key info so you can verify the right keys are loaded
console.log(`CRYPT_KEY_A: ${keyA.slice(0, 4)}... (${Buffer.byteLength(keyA, 'utf8')} bytes)`);
console.log(`CRYPT_KEY_B: ${keyB.slice(0, 4)}... (${Buffer.byteLength(keyB, 'utf8')} bytes)`);

const conn = await mysql.createConnection({
    host: process.env.DB_HOSTNAME ?? 'localhost',
    port: Number(process.env.DB_PORT ?? 5000),
    user: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE
});

console.log('Connected to DB.');

const [rows] = await conn.query('SELECT id, user_id, content FROM passwords ORDER BY id ASC');

// Print a sample content to help diagnose key/format issues
if (rows.length > 0) {
    const sample = rows[0].content;
    const decoded = Buffer.from(sample, 'base64');
    console.log(`Sample row id=${rows[0].id}: content length=${sample.length}, decoded bytes=${decoded.length}`);
    if (decoded.length < 80) {
        console.warn('  WARNING: decoded length < 80, not a valid encrypted blob');
    }
}

let ok = 0;
let migrated = 0;
let failed = 0;

for (const row of rows) {
    const { id, user_id, content } = row;

    // 1. Already valid with new format?
    if (decryptNew(keyA, keyB, content) !== null) {
        ok++;
        continue;
    }

    // 2. Recoverable with old format?
    const plain = decryptOld(keyA, keyB, content);
    if (plain !== null) {
        const newContent = encryptNew(keyA, keyB, plain);
        await conn.query('UPDATE passwords SET content = ? WHERE id = ?', [newContent, id]);
        console.log(`  [MIGRATED] id=${id} user_id=${user_id}`);
        migrated++;
        continue;
    }

    // 3. Unrecoverable
    console.warn(`  [FAILED]   id=${id} user_id=${user_id}  — cannot decrypt with old or new key, skipping`);
    failed++;
}

console.log(`\nDone: ${ok} already OK, ${migrated} migrated, ${failed} unrecoverable.`);
await conn.end();
