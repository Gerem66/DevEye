import type { DeviceRow, DeviceStatus } from 'deveye-types';
import { randomUUID } from 'crypto';
import type { Queryable } from '../pool';

type Q = Queryable;

export interface CreateDeviceInput {
    ownerId: number;
    name: string;
    fingerprint: string;
    platform: string;
    publicKey: string;
    tokenHash: string;
}

export interface DevicesRepo {
    findById(id: string): Promise<DeviceRow | null>;
    findByOwnerFingerprint(ownerId: number, fingerprint: string): Promise<DeviceRow | null>;
    listByOwner(ownerId: number): Promise<DeviceRow[]>;
    listAll(): Promise<DeviceRow[]>;
    create(input: CreateDeviceInput): Promise<DeviceRow>;
    setStatus(id: string, status: DeviceStatus): Promise<void>;
    setTokenHash(id: string, tokenHash: string): Promise<void>;
    rename(id: string, name: string): Promise<void>;
    touchSeen(id: string, lastSeen: number): Promise<void>;
    setReport(id: string, reportJson: string): Promise<void>;
    delete(id: string): Promise<boolean>;
}

export function devicesRepo(pool: Q): DevicesRepo {
    return {
        async findById(id) {
            const r = await pool.query<DeviceRow>('SELECT * FROM devices WHERE id = ?', [id]);
            return r.rows[0] ?? null;
        },
        async findByOwnerFingerprint(ownerId, fingerprint) {
            const r = await pool.query<DeviceRow>('SELECT * FROM devices WHERE owner_id = ? AND fingerprint = ?', [
                ownerId,
                fingerprint
            ]);
            return r.rows[0] ?? null;
        },
        async listByOwner(ownerId) {
            const r = await pool.query<DeviceRow>('SELECT * FROM devices WHERE owner_id = ? ORDER BY created DESC', [
                ownerId
            ]);
            return r.rows;
        },
        async listAll() {
            const r = await pool.query<DeviceRow>('SELECT * FROM devices ORDER BY created DESC');
            return r.rows;
        },
        async create({ ownerId, name, fingerprint, platform, publicKey, tokenHash }) {
            const id = randomUUID();
            await pool.query(
                `INSERT INTO devices (id, owner_id, name, fingerprint, platform, status, public_key, token_hash)
                 VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
                [id, ownerId, name, fingerprint, platform, publicKey, tokenHash]
            );
            const r = await pool.query<DeviceRow>('SELECT * FROM devices WHERE id = ?', [id]);
            return r.rows[0];
        },
        async setStatus(id, status) {
            await pool.query('UPDATE devices SET status = ? WHERE id = ?', [status, id]);
        },
        async setTokenHash(id, tokenHash) {
            await pool.query('UPDATE devices SET token_hash = ? WHERE id = ?', [tokenHash, id]);
        },
        async rename(id, name) {
            await pool.query('UPDATE devices SET name = ? WHERE id = ?', [name, id]);
        },
        async touchSeen(id, lastSeen) {
            await pool.query('UPDATE devices SET last_seen = ? WHERE id = ?', [lastSeen, id]);
        },
        async setReport(id, reportJson) {
            await pool.query('UPDATE devices SET report_json = ? WHERE id = ?', [reportJson, id]);
        },
        async delete(id) {
            const r = await pool.query('DELETE FROM devices WHERE id = ?', [id]);
            return r.rowCount > 0;
        }
    };
}

export interface LinkCodesRepo {
    /** `ttlSeconds === null` mints a code that never expires. */
    create(input: { userId: number; ttlSeconds: number | null }): Promise<{ code: string; expiresAt: number | null }>;
    consume(code: string): Promise<{ userId: number } | null>;
    listActive(userId: number): Promise<{ code: string; expiresAt: number | null }[]>;
    /** Delete one of the caller's still-active codes. Returns true if removed. */
    revoke(userId: number, code: string): Promise<boolean>;
}

function randomCode(): string {
    // Human-typable: 8 unambiguous base32-ish chars, grouped (XXXX-XXXX).
    const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    let raw = '';
    for (let i = 0; i < 8; i++) raw += alphabet[Math.floor(Math.random() * alphabet.length)];
    return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

export function linkCodesRepo(pool: Q): LinkCodesRepo {
    return {
        async create({ userId, ttlSeconds }) {
            const now = Math.floor(Date.now() / 1000);
            const expiresAt = ttlSeconds === null ? null : now + ttlSeconds;
            const code = randomCode();
            await pool.query('INSERT INTO device_link_codes (code, user_id, expires_at) VALUES (?, ?, ?)', [
                code,
                userId,
                expiresAt
            ]);
            return { code, expiresAt };
        },
        async consume(code) {
            const now = Math.floor(Date.now() / 1000);
            const r = await pool.query<{ user_id: number; expires_at: number | null; used_at: number | null }>(
                'SELECT user_id, expires_at, used_at FROM device_link_codes WHERE code = ?',
                [code]
            );
            const row = r.rows[0];
            if (!row || row.used_at !== null) return null;
            if (row.expires_at !== null && Number(row.expires_at) < now) return null;
            await pool.query('UPDATE device_link_codes SET used_at = ? WHERE code = ?', [now, code]);
            return { userId: row.user_id };
        },
        async listActive(userId) {
            const now = Math.floor(Date.now() / 1000);
            const r = await pool.query<{ code: string; expires_at: number | null }>(
                `SELECT code, expires_at FROM device_link_codes
                 WHERE user_id = ? AND used_at IS NULL AND (expires_at IS NULL OR expires_at > ?)
                 ORDER BY expires_at IS NULL DESC, expires_at ASC`,
                [userId, now]
            );
            return r.rows.map((row) => ({
                code: row.code,
                expiresAt: row.expires_at === null ? null : Number(row.expires_at)
            }));
        },
        async revoke(userId, code) {
            const r = await pool.query(
                'DELETE FROM device_link_codes WHERE code = ? AND user_id = ? AND used_at IS NULL',
                [code, userId]
            );
            return r.rowCount > 0;
        }
    };
}
