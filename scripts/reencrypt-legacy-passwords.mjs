/**
 * One-off re-encryption migration.
 *
 * Decrypts every password row using the OLD keys (tries both HMAC variants:
 * ripemd160(keyB) and raw keyB bytes) then re-encrypts with the NEW keys.
 *
 * Required env vars:
 *   OLD_KEY_A / OLD_KEY_B  — keys used when data was originally encrypted
 *   NEW_KEY_A / NEW_KEY_B  — new clean keys (32 hex chars recommended)
 *
 * DB connection: DB_HOSTNAME / DB_PORT / DB_USERNAME / DB_PASSWORD / DB_DATABASE
 * (loaded from .env if present, overridable via env vars)
 *
 * Run:
 *   OLD_KEY_A='...' OLD_KEY_B='...' NEW_KEY_A='...' NEW_KEY_B='...' \
 *     node scripts/reencrypt-legacy-passwords.mjs
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

const oldKeyA = process.env.OLD_KEY_A;
const oldKeyB = process.env.OLD_KEY_B;
const newKeyA = process.env.NEW_KEY_A;
const newKeyB = process.env.NEW_KEY_B;

if (!oldKeyA || !oldKeyB || !newKeyA || !newKeyB) {
    console.error('Required: OLD_KEY_A, OLD_KEY_B, NEW_KEY_A, NEW_KEY_B');
    console.error('');
    console.error('Suggested new keys (run this to generate):');
    console.error("  node -e \"const c=require('crypto');");
    console.error("    console.log('NEW_KEY_A=' + c.randomBytes(16).toString('hex'));");
    console.error("    console.log('NEW_KEY_B=' + c.randomBytes(16).toString('hex'));\"");
    process.exit(1);
}
if (Buffer.byteLength(oldKeyA, 'utf8') !== 32) {
    console.error(`OLD_KEY_A must be exactly 32 bytes (got ${Buffer.byteLength(oldKeyA, 'utf8')}).`);
    process.exit(1);
}
if (Buffer.byteLength(newKeyA, 'utf8') !== 32) {
    console.error(`NEW_KEY_A must be exactly 32 bytes (got ${Buffer.byteLength(newKeyA, 'utf8')}).`);
    process.exit(1);
}

console.log(`OLD_KEY_A: ${oldKeyA.slice(0, 4)}... (${Buffer.byteLength(oldKeyA, 'utf8')} bytes)`);
console.log(`OLD_KEY_B: ${oldKeyB.slice(0, 4)}... (${Buffer.byteLength(oldKeyB, 'utf8')} bytes)`);
console.log(`NEW_KEY_A: ${newKeyA.slice(0, 4)}... (${Buffer.byteLength(newKeyA, 'utf8')} bytes)`);
console.log(`NEW_KEY_B: ${newKeyB.slice(0, 4)}... (${Buffer.byteLength(newKeyB, 'utf8')} bytes)`);

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

let migrated = 0;
let failed = 0;

for (const row of rows) {
    const { id, user_id, content } = row;

    // Try to decrypt with old keys (ripemd160 HMAC first, then raw-bytes HMAC)
    const plain = decryptNew(oldKeyA, oldKeyB, content) ?? decryptOld(oldKeyA, oldKeyB, content);

    if (plain === null) {
        console.warn(`  [FAILED]   id=${id} user_id=${user_id}  — cannot decrypt with old keys, skipping`);
        failed++;
        continue;
    }

    // Re-encrypt with new keys
    const newContent = encryptNew(newKeyA, newKeyB, plain);
    await conn.query('UPDATE passwords SET content = ? WHERE id = ?', [newContent, id]);
    console.log(`  [MIGRATED] id=${id} user_id=${user_id}`);
    migrated++;
}

console.log(`\nDone: ${migrated} migrated, ${failed} unrecoverable.`);
console.log('');
console.log('Update your server config with:');
console.log(`  CRYPT_KEY_A=${newKeyA}`);
console.log(`  CRYPT_KEY_B=${newKeyB}`);
await conn.end();
