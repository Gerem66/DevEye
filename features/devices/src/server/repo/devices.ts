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
 * La table `devices` et sa jonction `device_workspaces`, vues de la flotte :
 * ce que la page Appareils et Monitoring lisent et changent d'une machine.
 * L'enrôlement (création, jeton, ré-appairage) et ce que l'agent rapporte
 * (`last_seen`, version, rapport) restent au socle, qui les écrit sans session.
 */
export interface DeviceRepo {
    findById(id: string): Promise<DeviceRow | null>;
    /**
     * Les lignes des identifiants donnés, dans l'ordre demandé : la liste de
     * l'espace vient de la façade (qui porte la garde et le rang), les lignes
     * entières d'ici. Un identifiant inconnu est simplement absent.
     */
    findByIds(ids: string[]): Promise<DeviceRow[]>;
    /** La flotte entière, du plus récent au plus ancien : la page Appareils. */
    listAll(): Promise<DeviceRow[]>;
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
     * Range les appareils d'un espace : `ids` est la liste complète, rang =
     * indice. Ne touche aucun état d'agent.
     */
    reorder(workspaceId: number, ids: string[]): Promise<void>;

    /** Les espaces ayant accès à cet appareil. */
    workspaceIdsOf(deviceId: string): Promise<number[]>;
    /**
     * Idem pour plusieurs appareils d'un coup : la page Appareils affiche la
     * flotte entière, et une requête par carte serait un N+1 pur.
     */
    workspaceIdsFor(deviceIds: string[]): Promise<Map<string, number[]>>;
    /**
     * Fixe l'ensemble des espaces ayant accès. La liste est complète : un espace
     * absent perd l'accès. Les rangs des espaces conservés ne bougent pas.
     */
    setWorkspaces(deviceId: string, workspaceIds: number[]): Promise<void>;
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
        async listAll() {
            return q.query<DeviceRow>('SELECT * FROM devices ORDER BY created DESC');
        },
        async setStatus(id, status) {
            await q.execute('UPDATE devices SET status = ? WHERE id = ?', [status, id]);
        },
        async rename(id, name) {
            await q.execute('UPDATE devices SET name = ? WHERE id = ?', [name, id]);
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
            // Keep the row (and its monitoring history) but neutralise the device:
            // wipe the token so it can never reconnect, and clear deletion bookkeeping.
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
            // Rang = indice ; un appareil que cet espace ne voit pas est ignoré
            // en silence, la clause `workspace_id` s'en charge. Rien d'autre
            // n'est touché : ranger n'est pas administrer une machine.
            //
            // Un seul UPDATE : une boucle laisserait un rangement à moitié
            // appliqué si une requête échouait, et deux rangements simultanés
            // s'entrelaceraient.
            if (ids.length === 0) return;
            const cases = ids.map(() => 'WHEN ? THEN ?').join(' ');
            const params: (string | number)[] = [];
            for (let i = 0; i < ids.length; i++) params.push(ids[i], i);
            await q.execute(
                `UPDATE device_workspaces
                    SET sort_order = CASE device_id ${cases} ELSE sort_order END
                  WHERE workspace_id = ? AND device_id IN (${ids.map(() => '?').join(',')})`,
                [...params, workspaceId, ...ids]
            );
        },

        async workspaceIdsOf(deviceId) {
            const rows = await q.query<{ workspace_id: number }>(
                'SELECT workspace_id FROM device_workspaces WHERE device_id = ?',
                [deviceId]
            );
            return rows.map((row) => Number(row.workspace_id));
        },
        async workspaceIdsFor(deviceIds) {
            const out = new Map<string, number[]>();
            if (deviceIds.length === 0) return out;
            const rows = await q.query<{ device_id: string; workspace_id: number }>(
                `SELECT device_id, workspace_id FROM device_workspaces
                 WHERE device_id IN (${deviceIds.map(() => '?').join(',')})`,
                deviceIds
            );
            for (const row of rows) {
                const list = out.get(row.device_id);
                if (list) list.push(Number(row.workspace_id));
                else out.set(row.device_id, [Number(row.workspace_id)]);
            }
            return out;
        },
        async setWorkspaces(deviceId, workspaceIds) {
            // Retirer d'abord, ajouter ensuite : les espaces conservés ne sont
            // pas touchés, donc leur rang survit au partage.
            if (workspaceIds.length === 0) {
                await q.execute('DELETE FROM device_workspaces WHERE device_id = ?', [deviceId]);
                return;
            }
            await q.execute(
                `DELETE FROM device_workspaces
                  WHERE device_id = ? AND workspace_id NOT IN (${workspaceIds.map(() => '?').join(',')})`,
                [deviceId, ...workspaceIds]
            );
            // Un espace qui gagne l'accès reçoit le dernier rang de *sa* liste.
            for (const workspaceId of workspaceIds) {
                await q.execute(
                    `INSERT IGNORE INTO device_workspaces (device_id, workspace_id, sort_order)
                     SELECT ?, ?, COALESCE(MAX(sort_order) + 1, 0) FROM device_workspaces WHERE workspace_id = ?`,
                    [deviceId, workspaceId, workspaceId]
                );
            }
        }
    };
}
