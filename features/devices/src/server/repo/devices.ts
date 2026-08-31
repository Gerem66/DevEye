import type { DeviceRow, DeviceStatus, ProcessCapture } from '@deveye/types';
import type { SdkQueryable } from '@deveye/types/sdk/server';

/** Partial collection config; only provided fields are updated (`null` resets). */
export interface DeviceConfigPatch {
    metricIntervalSeconds?: number | null;
    processCapture?: ProcessCapture | null;
    /** Conservation de l'historique entier : métriques, présence et processus. */
    retentionDays?: number | null;
}

/**
 * La table `devices`, vue de la feature. L'enrôlement et ce que l'agent
 * rapporte (`last_seen`, version, rapport) restent au socle, qui les écrit sans
 * session.
 */
export interface DeviceRepo {
    findById(id: string): Promise<DeviceRow | null>;
    /** Les lignes des identifiants donnés, dans l'ordre demandé ; un inconnu est absent. */
    findByIds(ids: string[]): Promise<DeviceRow[]>;
    /**
     * Les appareils que cet espace voit : les siens et ceux qui y sont projetés,
     * rangés selon le rang propre à cet espace.
     */
    listVisible(workspaceId: number): Promise<DeviceRow[]>;
    /** Un appareil visible depuis cet espace : chez lui, ou par projection. */
    findVisible(id: string, workspaceId: number): Promise<DeviceRow | null>;
    setStatus(id: string, status: DeviceStatus): Promise<void>;
    rename(id: string, name: string): Promise<void>;
    setConfig(id: string, patch: DeviceConfigPatch): Promise<void>;
    /** Mark a device for deletion, remembering its status so it can be restored. */
    requestDeletion(id: string, currentStatus: string): Promise<void>;
    /** Cancel a pending deletion: restore the remembered status, clear the error. */
    cancelDeletion(id: string): Promise<void>;
    /** Finalise a deletion: archive the device (its history is kept, frozen). */
    archive(id: string): Promise<void>;
    /** Hard purge: the row and, by FK cascade, all its history. */
    delete(id: string): Promise<boolean>;
    /**
     * Range les appareils chez eux : `ids` sont ceux dont cet espace est le
     * domicile, rang = indice. Le rang d'un appareil projeté appartient à
     * l'espace qui le reçoit (`ctx.sharing.setOrder`).
     */
    reorder(workspaceId: number, ids: string[]): Promise<void>;
}

export function deviceRepo(q: SdkQueryable): DeviceRepo {
    return {
        async findById(id) {
            const rows = await q.query<DeviceRow>('SELECT * FROM devices WHERE id = ?', [id]);
            return rows[0] ?? null;
        },
        async findByIds(ids) {
            if (ids.length === 0) return [];
            const rows = await q.query<DeviceRow>(
                `SELECT * FROM devices WHERE id IN (${ids.map(() => '?').join(',')})`,
                ids
            );
            // L'ordre est celui de l'appelant, pas celui de l'index.
            const byId = new Map(rows.map((r) => [r.id, r]));
            return ids.flatMap((id) => byId.get(id) ?? []);
        },
        async listVisible(workspaceId) {
            // Le rang est celui de l'espace qui regarde : le sien sur la ligne
            // quand l'appareil est chez lui, celui de la projection sinon.
            const rows = await q.query<DeviceRow & { rank_in_ws: number }>(
                `SELECT d.*, d.sort_order AS rank_in_ws FROM devices d WHERE d.workspace_id = ?
                 UNION ALL
                 SELECT d.*, sh.sort_order AS rank_in_ws FROM devices d
                   JOIN item_shares sh
                     ON sh.feature = 'devices' AND sh.item_id = d.id AND sh.home_workspace_id = d.workspace_id
                  WHERE sh.workspace_id = ?
                 ORDER BY rank_in_ws ASC, created DESC`,
                [workspaceId, workspaceId]
            );
            return rows;
        },
        async findVisible(id, workspaceId) {
            const rows = await q.query<DeviceRow>(
                `SELECT d.* FROM devices d
                  WHERE d.id = ?
                    AND (d.workspace_id = ?
                         OR EXISTS (SELECT 1 FROM item_shares sh
                                     WHERE sh.feature = 'devices' AND sh.item_id = d.id
                                       AND sh.home_workspace_id = d.workspace_id AND sh.workspace_id = ?))`,
                [id, workspaceId, workspaceId]
            );
            return rows[0] ?? null;
        },
        async setStatus(id, status) {
            await q.execute('UPDATE devices SET status = ? WHERE id = ?', [status, id]);
        },
        async rename(id, name) {
            await q.execute('UPDATE devices SET name = ? WHERE id = ?', [name, id]);
        },
        async setConfig(id, patch) {
            // Only update the fields present.
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
            await q.execute(`UPDATE devices SET ${sets.join(', ')} WHERE id = ?`, params);
        },
        async requestDeletion(id, currentStatus) {
            await q.execute(
                `UPDATE devices
                 SET status = 'pending_deletion', status_before_delete = ?, delete_error = NULL
                 WHERE id = ?`,
                [currentStatus, id]
            );
        },
        async cancelDeletion(id) {
            await q.execute(
                `UPDATE devices
                 SET status = COALESCE(status_before_delete, 'active'),
                     status_before_delete = NULL, delete_error = NULL
                 WHERE id = ? AND status = 'pending_deletion'`,
                [id]
            );
        },
        async archive(id) {
            // Keep the row and its history, wipe the token so it can never reconnect.
            await q.execute(
                `UPDATE devices
                 SET status = 'archived', token_hash = '', status_before_delete = NULL, delete_error = NULL
                 WHERE id = ?`,
                [id]
            );
        },
        async delete(id) {
            const r = await q.execute('DELETE FROM devices WHERE id = ?', [id]);
            return r.affectedRows > 0;
        },
        async reorder(workspaceId, ids) {
            // Un seul UPDATE : une boucle laisserait un rangement à moitié
            // appliqué si une requête échouait, et deux rangements simultanés
            // s'entrelaceraient. Un appareil qui n'habite pas cet espace est
            // ignoré par la clause `workspace_id`.
            if (ids.length === 0) return;
            const cases = ids.map(() => 'WHEN ? THEN ?').join(' ');
            const params: (string | number)[] = [];
            for (let i = 0; i < ids.length; i++) params.push(ids[i], i);
            await q.execute(
                `UPDATE devices
                    SET sort_order = CASE id ${cases} ELSE sort_order END
                  WHERE workspace_id = ? AND id IN (${ids.map(() => '?').join(',')})`,
                [...params, workspaceId, ...ids]
            );
        }
    };
}
