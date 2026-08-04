import type { DeviceRow, DeviceStatus, ProcessCapture } from 'deveye-types';
import { randomUUID } from 'crypto';
import type { Queryable } from '../pool';

type Q = Queryable;

/** Partial collection config; only provided fields are updated (`null` resets). */
export interface DeviceConfigPatch {
    metricIntervalSeconds?: number | null;
    processCapture?: ProcessCapture | null;
    retentionDays?: number | null;
    processRetentionDays?: number | null;
}

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
    /** Store the agent version reported on connect (`agent.hello`). */
    setAgentVersion(id: string, version: string): Promise<void>;
    /** Store the build target reported on connect (`agent.hello`), for self-update. */
    setAgentTarget(id: string, target: string): Promise<void>;
    setReport(id: string, reportJson: string): Promise<void>;
    setConfig(id: string, patch: DeviceConfigPatch): Promise<void>;
    /** Mark a device for deletion, remembering its status so it can be restored. */
    requestDeletion(id: string, currentStatus: string): Promise<void>;
    /** Cancel a pending deletion: restore the remembered status, clear the error. */
    cancelDeletion(id: string): Promise<void>;
    /**
     * Reset a device to a freshly-enrolled state: set its status (`pending` or
     * `active`) and clear any deletion bookkeeping. Used on (re)enrollment so a
     * previously archived/revoked machine re-pairs into a clean, visible state.
     */
    markEnrolled(id: string, status: DeviceStatus): Promise<void>;
    /** Finalise a deletion: archive the device (its history is kept, frozen). */
    archive(id: string): Promise<void>;
    /** Abort a deletion after a self-destruct failure: restore status + record why. */
    failDeletion(id: string, message: string): Promise<void>;
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
        async setAgentVersion(id, version) {
            await pool.query('UPDATE devices SET agent_version = ? WHERE id = ?', [version.slice(0, 64), id]);
        },
        async setAgentTarget(id, target) {
            await pool.query('UPDATE devices SET agent_target = ? WHERE id = ?', [target.slice(0, 32), id]);
        },
        async setReport(id, reportJson) {
            await pool.query('UPDATE devices SET report_json = ? WHERE id = ?', [reportJson, id]);
        },
        async setConfig(id, patch) {
            // Map each provided field to its column; only update what's present.
            const columns: Record<keyof DeviceConfigPatch, string> = {
                metricIntervalSeconds: 'metric_interval_seconds',
                processCapture: 'process_capture',
                retentionDays: 'retention_days',
                processRetentionDays: 'process_retention_days'
            };
            const sets: string[] = [];
            const params: unknown[] = [];
            for (const key of Object.keys(columns) as (keyof DeviceConfigPatch)[]) {
                if (patch[key] !== undefined) {
                    sets.push(`${columns[key]} = ?`);
                    params.push(patch[key]);
                }
            }
            if (sets.length === 0) return;
            params.push(id);
            await pool.query(`UPDATE devices SET ${sets.join(', ')} WHERE id = ?`, params);
        },
        async requestDeletion(id, currentStatus) {
            await pool.query(
                `UPDATE devices
                 SET status = 'pending_deletion', status_before_delete = ?, delete_error = NULL
                 WHERE id = ?`,
                [currentStatus, id]
            );
        },
        async cancelDeletion(id) {
            await pool.query(
                `UPDATE devices
                 SET status = COALESCE(status_before_delete, 'active'),
                     status_before_delete = NULL, delete_error = NULL
                 WHERE id = ? AND status = 'pending_deletion'`,
                [id]
            );
        },
        async markEnrolled(id, status) {
            await pool.query(
                `UPDATE devices SET status = ?, status_before_delete = NULL, delete_error = NULL WHERE id = ?`,
                [status, id]
            );
        },
        async archive(id) {
            // Keep the row (and its monitoring history) but neutralise the device:
            // wipe the token so it can never reconnect, and clear deletion bookkeeping.
            await pool.query(
                `UPDATE devices
                 SET status = 'archived', token_hash = '', status_before_delete = NULL, delete_error = NULL
                 WHERE id = ?`,
                [id]
            );
        },
        async failDeletion(id, message) {
            await pool.query(
                `UPDATE devices
                 SET status = COALESCE(status_before_delete, 'active'),
                     status_before_delete = NULL, delete_error = ?
                 WHERE id = ?`,
                [message.slice(0, 255), id]
            );
        },
        async delete(id) {
            const r = await pool.query('DELETE FROM devices WHERE id = ?', [id]);
            return r.rowCount > 0;
        }
    };
}

export interface LinkCode {
    code: string;
    expiresAt: number | null;
    autoApprove: boolean;
}

export interface LinkCodesRepo {
    /** `ttlSeconds === null` mints a code that never expires. */
    create(input: { userId: number; ttlSeconds: number | null; autoApprove: boolean }): Promise<LinkCode>;
    consume(code: string): Promise<{ userId: number; autoApprove: boolean } | null>;
    listActive(userId: number): Promise<LinkCode[]>;
    /** Toggle auto-approval on one of the caller's still-active codes (else null). */
    setAutoApprove(userId: number, code: string, autoApprove: boolean): Promise<LinkCode | null>;
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
        async create({ userId, ttlSeconds, autoApprove }) {
            const now = Math.floor(Date.now() / 1000);
            const expiresAt = ttlSeconds === null ? null : now + ttlSeconds;
            const code = randomCode();
            await pool.query(
                'INSERT INTO device_link_codes (code, user_id, expires_at, auto_approve) VALUES (?, ?, ?, ?)',
                [code, userId, expiresAt, autoApprove ? 1 : 0]
            );
            return { code, expiresAt, autoApprove };
        },
        async consume(code) {
            const now = Math.floor(Date.now() / 1000);
            const r = await pool.query<{
                user_id: number;
                expires_at: number | null;
                used_at: number | null;
                auto_approve: number;
            }>('SELECT user_id, expires_at, used_at, auto_approve FROM device_link_codes WHERE code = ?', [code]);
            const row = r.rows[0];
            if (!row || row.used_at !== null) return null;
            if (row.expires_at !== null && Number(row.expires_at) < now) return null;
            await pool.query('UPDATE device_link_codes SET used_at = ? WHERE code = ?', [now, code]);
            return { userId: row.user_id, autoApprove: Number(row.auto_approve) === 1 };
        },
        async listActive(userId) {
            const now = Math.floor(Date.now() / 1000);
            const r = await pool.query<{ code: string; expires_at: number | null; auto_approve: number }>(
                `SELECT code, expires_at, auto_approve FROM device_link_codes
                 WHERE user_id = ? AND used_at IS NULL AND (expires_at IS NULL OR expires_at > ?)
                 ORDER BY expires_at IS NULL DESC, expires_at ASC`,
                [userId, now]
            );
            return r.rows.map((row) => ({
                code: row.code,
                expiresAt: row.expires_at === null ? null : Number(row.expires_at),
                autoApprove: Number(row.auto_approve) === 1
            }));
        },
        async setAutoApprove(userId, code, autoApprove) {
            const now = Math.floor(Date.now() / 1000);
            const upd = await pool.query(
                `UPDATE device_link_codes SET auto_approve = ?
                 WHERE code = ? AND user_id = ? AND used_at IS NULL AND (expires_at IS NULL OR expires_at > ?)`,
                [autoApprove ? 1 : 0, code, userId, now]
            );
            if (upd.rowCount === 0) return null;
            const r = await pool.query<{ code: string; expires_at: number | null; auto_approve: number }>(
                'SELECT code, expires_at, auto_approve FROM device_link_codes WHERE code = ?',
                [code]
            );
            const row = r.rows[0];
            if (!row) return null;
            return {
                code: row.code,
                expiresAt: row.expires_at === null ? null : Number(row.expires_at),
                autoApprove: Number(row.auto_approve) === 1
            };
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
