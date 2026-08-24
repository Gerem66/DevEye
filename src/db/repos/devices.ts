import type { DeviceRow, DeviceStatus, ProcessCapture } from '@deveye/types';
import { randomInt, randomUUID } from 'crypto';
import type { Queryable } from '../pool';

type Q = Queryable;

/** Partial collection config; only provided fields are updated (`null` resets). */
export interface DeviceConfigPatch {
    metricIntervalSeconds?: number | null;
    processCapture?: ProcessCapture | null;
    /** Conservation de l'historique entier : métriques, présence et processus. */
    retentionDays?: number | null;
}

/**
 * Réglages Sentinelle d'un appareil. Séparé de `DeviceConfigPatch` parce que ce
 * sont deux cadrans distincts : l'un règle ce que l'agent mesure en continu,
 * l'autre décide si on le surveille — et une feature n'a pas à pouvoir modifier
 * les réglages de l'autre en passant.
 */
export interface DeviceSentinelPatch {
    enabled?: boolean;
    /** Unix ms de fin d'apprentissage ; `null` remet à zéro. */
    learningUntil?: number | null;
    integrityMinutes?: number;
    authEvents?: boolean;
}

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
    setSentinelConfig(id: string, patch: DeviceSentinelPatch): Promise<void>;
    /** Date le dernier manifeste de persistance reçu (unix ms). */
    touchIntegrity(id: string, at: number): Promise<void>;
    /**
     * Les appareils sur lesquels Sentinelle tourne, tous espaces confondus.
     *
     * Le moteur n'a ni session ni espace courant : il balaye la flotte entière,
     * exactement comme l'ordonnanceur d'Uptime. Les appareils archivés en sont
     * exclus — leur historique est figé, il n'y a plus rien à y détecter.
     */
    listSentinelEnabled(): Promise<DeviceRow[]>;
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
    /**
     * Range les appareils d'un espace : `ids` est la liste complète, rang =
     * indice. Ne touche aucun état d'agent.
     */
    reorder(workspaceId: number, ids: string[]): Promise<void>;

    // ─────────────────────────── partage entre espaces ───────────────────────
    /** Les espaces ayant accès à cet appareil. */
    workspaceIdsOf(deviceId: string): Promise<number[]>;
    /**
     * Idem pour plusieurs appareils d'un coup — la page Appareils affiche la
     * flotte entière, et une requête par carte serait un N+1 pur.
     */
    workspaceIdsFor(deviceIds: string[]): Promise<Map<string, number[]>>;
    /** Cet espace a-t-il accès à cet appareil ? La frontière, en une question. */
    hasWorkspace(deviceId: string, workspaceId: number): Promise<boolean>;
    /**
     * Fixe l'ensemble des espaces ayant accès. La liste est complète : un espace
     * absent perd l'accès. Les rangs des espaces conservés ne bougent pas.
     */
    setWorkspaces(deviceId: string, workspaceIds: number[]): Promise<void>;
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
            // espace avec lequel il est partagé, rangé selon *ce* rang-là.
            // L'ordre de l'utilisateur ; la date ne fait que départager.
            const r = await pool.query<DeviceRow>(
                `SELECT d.* FROM devices d
                 JOIN device_workspaces dw ON dw.device_id = d.id
                 WHERE dw.workspace_id = ?
                 ORDER BY dw.sort_order ASC, d.created DESC`,
                [workspaceId]
            );
            return r.rows;
        },
        async reorder(workspaceId, ids) {
            // Rang = indice ; un appareil que cet espace ne voit pas est ignoré
            // en silence, la clause `workspace_id` s'en charge. Rien d'autre
            // n'est touché : ranger n'est pas administrer une machine.
            //
            // Un seul UPDATE, dans une transaction : la boucle d'origine laissait
            // un rangement à moitié appliqué si une requête échouait, et deux
            // rangements simultanés s'entrelaçaient.
            if (ids.length === 0) return;
            const cases = ids.map(() => 'WHEN ? THEN ?').join(' ');
            const params: (string | number)[] = [];
            for (let i = 0; i < ids.length; i++) params.push(ids[i], i);
            await pool.query(
                `UPDATE device_workspaces
                    SET sort_order = CASE device_id ${cases} ELSE sort_order END
                  WHERE workspace_id = ? AND device_id IN (${ids.map(() => '?').join(',')})`,
                [...params, workspaceId, ...ids]
            );
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
            // L'espace d'appairage est le premier à y avoir accès. Un nouvel
            // appareil atterrit à la fin de sa liste, jamais au milieu :
            // l'ordre appartient à l'utilisateur.
            await pool.query(
                `INSERT INTO device_workspaces (device_id, workspace_id, sort_order)
                 SELECT ?, ?, COALESCE(MAX(sort_order) + 1, 0) FROM device_workspaces WHERE workspace_id = ?`,
                [id, workspaceId, workspaceId]
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
                retentionDays: 'retention_days'
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
        async setSentinelConfig(id, patch) {
            const columns: Record<keyof DeviceSentinelPatch, string> = {
                enabled: 'sentinel_enabled',
                learningUntil: 'sentinel_learning_until',
                integrityMinutes: 'sentinel_integrity_minutes',
                authEvents: 'sentinel_auth_events'
            };
            const sets: string[] = [];
            const params: unknown[] = [];
            for (const key of Object.keys(columns) as (keyof DeviceSentinelPatch)[]) {
                const value = patch[key];
                if (value === undefined) continue;
                sets.push(`${columns[key]} = ?`);
                // Les deux drapeaux sont des TINYINT : les passer en booléens
                // JS marcherait, mais mysql2 les sérialiserait en 0/1 sans le
                // dire, et une relecture rendrait un type différent de celui
                // qu'on croit écrire.
                params.push(typeof value === 'boolean' ? (value ? 1 : 0) : value);
            }
            if (sets.length === 0) return;
            params.push(id);
            await pool.query(`UPDATE devices SET ${sets.join(', ')} WHERE id = ?`, params);
        },
        async touchIntegrity(id, at) {
            await pool.query('UPDATE devices SET sentinel_last_integrity_at = ? WHERE id = ?', [at, id]);
        },
        async listSentinelEnabled() {
            const r = await pool.query<DeviceRow>(
                `SELECT * FROM devices
                 WHERE sentinel_enabled = 1 AND status = 'active'
                 ORDER BY id ASC`
            );
            return r.rows;
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
        },

        async workspaceIdsOf(deviceId) {
            const r = await pool.query<{ workspace_id: number }>(
                'SELECT workspace_id FROM device_workspaces WHERE device_id = ?',
                [deviceId]
            );
            return r.rows.map((row) => Number(row.workspace_id));
        },
        async workspaceIdsFor(deviceIds) {
            const out = new Map<string, number[]>();
            if (deviceIds.length === 0) return out;
            const r = await pool.query<{ device_id: string; workspace_id: number }>(
                `SELECT device_id, workspace_id FROM device_workspaces
                 WHERE device_id IN (${deviceIds.map(() => '?').join(',')})`,
                deviceIds
            );
            for (const row of r.rows) {
                const list = out.get(row.device_id);
                if (list) list.push(Number(row.workspace_id));
                else out.set(row.device_id, [Number(row.workspace_id)]);
            }
            return out;
        },
        async hasWorkspace(deviceId, workspaceId) {
            const r = await pool.query<{ n: number }>(
                'SELECT 1 AS n FROM device_workspaces WHERE device_id = ? AND workspace_id = ? LIMIT 1',
                [deviceId, workspaceId]
            );
            return r.rows.length > 0;
        },
        async setWorkspaces(deviceId, workspaceIds) {
            // Retirer d'abord, ajouter ensuite : les espaces conservés ne sont
            // pas touchés, donc leur rang survit au partage.
            if (workspaceIds.length === 0) {
                await pool.query('DELETE FROM device_workspaces WHERE device_id = ?', [deviceId]);
                return;
            }
            await pool.query(
                `DELETE FROM device_workspaces
                  WHERE device_id = ? AND workspace_id NOT IN (${workspaceIds.map(() => '?').join(',')})`,
                [deviceId, ...workspaceIds]
            );
            // Un espace qui gagne l'accès reçoit le dernier rang de *sa* liste.
            for (const workspaceId of workspaceIds) {
                await pool.query(
                    `INSERT IGNORE INTO device_workspaces (device_id, workspace_id, sort_order)
                     SELECT ?, ?, COALESCE(MAX(sort_order) + 1, 0) FROM device_workspaces WHERE workspace_id = ?`,
                    [deviceId, workspaceId, workspaceId]
                );
            }
        }
    };
}

export interface LinkCode {
    code: string;
    expiresAt: number | null;
    autoApprove: boolean;
}

export interface LinkCodesRepo {
    create(input: {
        /** Émetteur du code. */
        userId: number;
        /** Espace dans lequel la machine sera rangée à l'enrôlement. */
        workspaceId: number;
        /** `null` mints a code that never expires. */
        ttlSeconds: number | null;
        autoApprove: boolean;
    }): Promise<LinkCode>;
    consume(code: string): Promise<{ userId: number; workspaceId: number; autoApprove: boolean } | null>;
    listActive(userId: number): Promise<LinkCode[]>;
    /** Toggle auto-approval on one of the caller's still-active codes (else null). */
    setAutoApprove(userId: number, code: string, autoApprove: boolean): Promise<LinkCode | null>;
    /** Delete one of the caller's still-active codes. Returns true if removed. */
    revoke(userId: number, code: string): Promise<boolean>;
}

function randomCode(): string {
    // Human-typable: 8 unambiguous base32-ish chars, grouped (XXXX-XXXX).
    //
    // Tiré cryptographiquement, comme tout secret ici : ce code est la seule
    // pièce d'identité qui enrôle une machine dans un espace, et `Math.random`
    // n'est pas imprévisible. `randomInt` fait lui-même le rejet d'échantillon,
    // donc l'alphabet de 31 symboles reste uniforme malgré sa taille non
    // puissance de deux.
    const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    let raw = '';
    for (let i = 0; i < 8; i++) raw += alphabet[randomInt(alphabet.length)];
    return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

export function linkCodesRepo(pool: Q): LinkCodesRepo {
    return {
        async create({ userId, workspaceId, ttlSeconds, autoApprove }) {
            const now = Math.floor(Date.now() / 1000);
            const expiresAt = ttlSeconds === null ? null : now + ttlSeconds;
            const code = randomCode();
            await pool.query(
                'INSERT INTO device_link_codes (code, user_id, workspace_id, expires_at, auto_approve) VALUES (?, ?, ?, ?, ?)',
                [code, userId, workspaceId, expiresAt, autoApprove ? 1 : 0]
            );
            return { code, expiresAt, autoApprove };
        },
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
