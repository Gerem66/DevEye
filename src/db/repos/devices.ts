import type { DeviceRow, DeviceStatus } from '@deveye/types';
import { randomUUID } from 'crypto';
import type { Queryable } from '../pool';

type Q = Queryable;

/**
 * Le dépôt du socle : ce que l'infrastructure écrit hors session (enrôlement,
 * rapports d'agent, présence) et ce que la façade du SDK lit. La flotte et
 * l'historique sont les requêtes du module `features/devices`, sur ces mêmes
 * tables.
 */

export interface CreateDeviceInput {
    ownerId: number;
    workspaceId: number;
    name: string;
    fingerprint: string;
    platform: string;
    publicKey: string;
    tokenHash: string;
}

export interface DevicesRepo {
    findById(id: string): Promise<DeviceRow | null>;
    findByWorkspaceFingerprint(workspaceId: number, fingerprint: string): Promise<DeviceRow | null>;
    listByWorkspace(workspaceId: number): Promise<DeviceRow[]>;
    listAll(): Promise<DeviceRow[]>;
    create(input: CreateDeviceInput): Promise<DeviceRow>;
    setTokenHash(id: string, tokenHash: string): Promise<void>;
    touchSeen(id: string, lastSeen: number): Promise<void>;
    /** Store the agent version reported on connect (`agent.hello`). */
    setAgentVersion(id: string, version: string): Promise<void>;
    /** Store the build target reported on connect (`agent.hello`), for self-update. */
    setAgentTarget(id: string, target: string): Promise<void>;
    setReport(id: string, reportJson: string): Promise<void>;
    /**
     * Reset a device to a freshly-enrolled state (status + cleared deletion
     * bookkeeping), so a previously archived/revoked machine re-pairs cleanly.
     */
    markEnrolled(id: string, status: DeviceStatus): Promise<void>;
    /** Finalise a deletion: archive the device (its history is kept, frozen). */
    archive(id: string): Promise<void>;
    /** Abort a deletion after a self-destruct failure: restore status + record why. */
    failDeletion(id: string, message: string): Promise<void>;

    // Le partage lui-même (`devices.setWorkspaces`) s'écrit dans le module.
    /** Les espaces ayant accès à cet appareil. */
    workspaceIdsOf(deviceId: string): Promise<number[]>;
    /** Cet espace a-t-il accès à cet appareil ? La frontière, en une question. */
    hasWorkspace(deviceId: string, workspaceId: number): Promise<boolean>;
}

export function devicesRepo(pool: Q): DevicesRepo {
    return {
        async findById(id) {
            const r = await pool.query<DeviceRow>('SELECT * FROM devices WHERE id = ?', [id]);
            return r.rows[0] ?? null;
        },
        async findByWorkspaceFingerprint(workspaceId, fingerprint) {
            const r = await pool.query<DeviceRow>('SELECT * FROM devices WHERE workspace_id = ? AND fingerprint = ?', [
                workspaceId,
                fingerprint
            ]);
            return r.rows[0] ?? null;
        },
        async listByWorkspace(workspaceId) {
            // La jonction est la frontière : un appareil apparaît dans chaque
            // espace avec lequel il est partagé, rangé selon ce rang-là.
            const r = await pool.query<DeviceRow>(
                `SELECT d.* FROM devices d
                 JOIN device_workspaces dw ON dw.device_id = d.id
                 WHERE dw.workspace_id = ?
                 ORDER BY dw.sort_order ASC, d.created DESC`,
                [workspaceId]
            );
            return r.rows;
        },
        async listAll() {
            const r = await pool.query<DeviceRow>('SELECT * FROM devices ORDER BY created DESC');
            return r.rows;
        },
        async create({ ownerId, workspaceId, name, fingerprint, platform, publicKey, tokenHash }) {
            const id = randomUUID();
            await pool.query(
                `INSERT INTO devices (id, owner_id, workspace_id, name, fingerprint, platform, status, public_key, token_hash)
                 VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
                [id, ownerId, workspaceId, name, fingerprint, platform, publicKey, tokenHash]
            );
            // L'espace d'appairage est le premier à y avoir accès ; un nouvel
            // appareil atterrit à la fin de sa liste, l'ordre appartient à l'utilisateur.
            await pool.query(
                `INSERT INTO device_workspaces (device_id, workspace_id, sort_order)
                 SELECT ?, ?, COALESCE(MAX(sort_order) + 1, 0) FROM device_workspaces WHERE workspace_id = ?`,
                [id, workspaceId, workspaceId]
            );
            const r = await pool.query<DeviceRow>('SELECT * FROM devices WHERE id = ?', [id]);
            return r.rows[0];
        },
        async setTokenHash(id, tokenHash) {
            await pool.query('UPDATE devices SET token_hash = ? WHERE id = ?', [tokenHash, id]);
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
        async workspaceIdsOf(deviceId) {
            const r = await pool.query<{ workspace_id: number }>(
                'SELECT workspace_id FROM device_workspaces WHERE device_id = ?',
                [deviceId]
            );
            return r.rows.map((row) => Number(row.workspace_id));
        },
        async hasWorkspace(deviceId, workspaceId) {
            const r = await pool.query<{ n: number }>(
                'SELECT 1 AS n FROM device_workspaces WHERE device_id = ? AND workspace_id = ? LIMIT 1',
                [deviceId, workspaceId]
            );
            return r.rows.length > 0;
        }
    };
}

/**
 * Les codes de liaison, côté consommation (l'enrôlement échange un code contre
 * un appareil). L'émission et la révocation sont les commandes
 * `devices.linkCode*` du module.
 */
export interface LinkCodesRepo {
    consume(code: string): Promise<{ userId: number; workspaceId: number; autoApprove: boolean } | null>;
}

export function linkCodesRepo(pool: Q): LinkCodesRepo {
    return {
        async consume(code) {
            const now = Math.floor(Date.now() / 1000);
            const r = await pool.query<{
                user_id: number;
                workspace_id: number;
                expires_at: number | null;
                used_at: number | null;
                auto_approve: number;
            }>(
                'SELECT user_id, workspace_id, expires_at, used_at, auto_approve FROM device_link_codes WHERE code = ?',
                [code]
            );
            const row = r.rows[0];
            if (!row || row.used_at !== null) return null;
            if (row.expires_at !== null && Number(row.expires_at) < now) return null;
            await pool.query('UPDATE device_link_codes SET used_at = ? WHERE code = ?', [now, code]);
            return {
                userId: row.user_id,
                workspaceId: row.workspace_id,
                autoApprove: Number(row.auto_approve) === 1
            };
        }
    };
}
