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
    status: DeviceStatus;
    tokenHash: string;
}

export interface DevicesRepo {
    findById(id: string): Promise<DeviceRow | null>;
    findByWorkspaceFingerprint(workspaceId: number, fingerprint: string): Promise<DeviceRow | null>;
    /** Un appareil visible depuis cet espace : chez lui, ou projeté ici. */
    findVisible(id: string, workspaceId: number): Promise<DeviceRow | null>;
    listByWorkspace(workspaceId: number): Promise<DeviceRow[]>;
    create(input: CreateDeviceInput): Promise<DeviceRow>;
    /**
     * Pose le condensé du jeton courant et celui du jeton qu'il remplace (`null`
     * à l'enrôlement : l'ancien jeton d'une machine réappairée ne vaut plus rien).
     */
    setTokenHashes(id: string, current: string, previous: string | null): Promise<void>;
    /** L'agent s'est authentifié avec le jeton courant : l'ancien peut tomber. */
    clearPreviousTokenHash(id: string): Promise<void>;
    touchSeen(id: string, lastSeen: number): Promise<void>;
    /** Store the agent version reported on connect (`agent.hello`). */
    setAgentVersion(id: string, version: string): Promise<void>;
    /** Store the build target reported on connect (`agent.hello`), for self-update. */
    setAgentTarget(id: string, target: string): Promise<void>;
    setReport(id: string, reportJson: string): Promise<void>;
    /**
     * Reset a device to a freshly-enrolled state (status + cleared deletion
     * bookkeeping), so an archived machine re-pairs cleanly.
     */
    markEnrolled(id: string, status: DeviceStatus): Promise<void>;
    countActiveInWorkspaces(workspaceIds: readonly number[]): Promise<number>;
    /** Finalise a deletion: archive the device (its history is kept, frozen). */
    archive(id: string): Promise<void>;
    /** Abort a deletion after a self-destruct failure: restore status + record why. */
    failDeletion(id: string, message: string): Promise<void>;
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
        async findVisible(id, workspaceId) {
            const r = await pool.query<DeviceRow>(
                `SELECT d.* FROM devices d
                  WHERE d.id = ?
                    AND (d.workspace_id = ?
                         OR EXISTS (SELECT 1 FROM item_shares sh
                                     WHERE sh.feature = 'devices' AND sh.item_id = d.id
                                       AND sh.home_workspace_id = d.workspace_id AND sh.workspace_id = ?))`,
                [id, workspaceId, workspaceId]
            );
            return r.rows[0] ?? null;
        },
        async listByWorkspace(workspaceId) {
            // La frontière est l'espace : les appareils d'ici, et ceux qu'une
            // projection y rend visibles, rangés selon le rang d'ici.
            const r = await pool.query<DeviceRow & { rank_in_ws: number }>(
                `SELECT d.*, d.sort_order AS rank_in_ws FROM devices d WHERE d.workspace_id = ?
                 UNION ALL
                 SELECT d.*, sh.sort_order AS rank_in_ws FROM devices d
                   JOIN item_shares sh
                     ON sh.feature = 'devices' AND sh.item_id = d.id AND sh.home_workspace_id = d.workspace_id
                  WHERE sh.workspace_id = ?
                 ORDER BY rank_in_ws ASC, created DESC`,
                [workspaceId, workspaceId]
            );
            return r.rows;
        },
        async create({ ownerId, workspaceId, name, fingerprint, platform, status, tokenHash }) {
            const id = randomUUID();
            await pool.query(
                `INSERT INTO devices (id, owner_id, workspace_id, name, fingerprint, platform, status, token_hash)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [id, ownerId, workspaceId, name, fingerprint, platform, status, tokenHash]
            );
            // Un nouvel appareil atterrit à la fin de la liste de son espace :
            // l'ordre appartient à l'utilisateur.
            await pool.query(
                `UPDATE devices SET sort_order =
                     (SELECT rank_end FROM (
                          SELECT COALESCE(MAX(sort_order), -1) + 1 AS rank_end
                            FROM devices WHERE workspace_id = ? AND id <> ?
                      ) AS t)
                  WHERE id = ?`,
                [workspaceId, id, id]
            );
            const r = await pool.query<DeviceRow>('SELECT * FROM devices WHERE id = ?', [id]);
            return r.rows[0];
        },
        async setTokenHashes(id, current, previous) {
            await pool.query('UPDATE devices SET token_hash = ?, token_hash_prev = ? WHERE id = ?', [
                current,
                previous,
                id
            ]);
        },
        async clearPreviousTokenHash(id) {
            await pool.query('UPDATE devices SET token_hash_prev = NULL WHERE id = ? AND token_hash_prev IS NOT NULL', [
                id
            ]);
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
        async countActiveInWorkspaces(workspaceIds) {
            if (workspaceIds.length === 0) return 0;
            const r = await pool.query<{ n: number }>(
                "SELECT COUNT(*) AS n FROM devices WHERE status = 'active' AND workspace_id IN (?)",
                [[...workspaceIds]]
            );
            return Number(r.rows[0].n);
        },
        async archive(id) {
            // Keep the row (and its monitoring history) but neutralise the device:
            // wipe the token so it can never reconnect, and clear deletion bookkeeping.
            await pool.query(
                `UPDATE devices
                 SET status = 'archived', token_hash = '', token_hash_prev = NULL, status_before_delete = NULL,
                     delete_error = NULL
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
        }
    };
}

/**
 * Les codes de liaison, côté consommation (l'enrôlement échange un code contre
 * un appareil). L'émission et la révocation sont les commandes
 * `devices.linkCode*` du module. Un code sert `max_uses` fois avant son
 * échéance, `used_at` date son dernier usage. L'enrôlement relit le code avant
 * d'en dépenser un usage : un refus de l'offre ne doit pas le brûler.
 */
export interface LinkCodesRepo {
    /** L'émetteur, l'espace et le nombre d'usages d'un code encore valable, sans en dépenser. */
    peek(code: string): Promise<{ userId: number; workspaceId: number; maxUses: number } | null>;
    /** Dépense un usage du code s'il en reste. Faux si d'autres ont pris les derniers entre-temps. */
    consume(code: string): Promise<boolean>;
}

export function linkCodesRepo(pool: Q): LinkCodesRepo {
    return {
        async peek(code) {
            const now = Math.floor(Date.now() / 1000);
            const r = await pool.query<{ user_id: number; workspace_id: number; max_uses: number }>(
                'SELECT user_id, workspace_id, max_uses FROM device_link_codes WHERE code = ? AND uses < max_uses AND expires_at >= ?',
                [code, now]
            );
            const row = r.rows[0];
            return row ? { userId: row.user_id, workspaceId: row.workspace_id, maxUses: row.max_uses } : null;
        },
        async consume(code) {
            // Compter et valider d'un seul coup : deux enrôlements simultanés ne
            // prennent pas tous les deux le dernier usage.
            const now = Math.floor(Date.now() / 1000);
            const res = await pool.query(
                'UPDATE device_link_codes SET uses = uses + 1, used_at = ? WHERE code = ? AND uses < max_uses AND expires_at >= ?',
                [now, code, now]
            );
            return res.rowCount === 1;
        }
    };
}
