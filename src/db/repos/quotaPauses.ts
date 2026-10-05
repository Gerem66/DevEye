import { selectColumns } from '../columns';
import type { Queryable } from '../pool';

type Q = Queryable;

export interface QuotaPauseRow {
    quotaKey: string;
    itemId: string;
    ownerUserId: number;
    workspaceId: number;
}

/**
 * Ce que l'offre de son propriétaire tient en pause (voir
 * `Services/planPauses.ts`, seul à écrire ici).
 */
export interface QuotaPausesRepo {
    all(): Promise<QuotaPauseRow[]>;
    /** Verrouillées quand l'appel est dans une transaction : deux passes ne se croisent pas. */
    ofOwnerKey(ownerUserId: number, quotaKey: string): Promise<QuotaPauseRow[]>;
    /** Réécrit le propriétaire et l'espace d'une ligne existante : un élément déplacé les change. */
    upsert(rows: readonly QuotaPauseRow[]): Promise<void>;
    remove(ownerUserId: number, quotaKey: string, itemIds: readonly string[]): Promise<void>;
    /** Les clés qu'aucune source ne tient plus : un module désinstallé ne laisse rien en pause. */
    purgeKeysOtherThan(quotaKeys: readonly string[]): Promise<number>;
    owners(): Promise<number[]>;
    setRecheck(ownerUserId: number, dueAt: number): Promise<void>;
    /** Les comptes dont l'offre change d'elle-même d'ici `now`, retirés de la liste. */
    takeDueRechecks(now: number): Promise<number[]>;
}

/** Ligne de `quota_pauses`. */
interface QuotaPauseRaw {
    quota_key: string;
    item_id: string;
    owner_user_id: number;
    workspace_id: number;
}

const COLUMNS = selectColumns<QuotaPauseRaw>(null, {
    quota_key: true,
    item_id: true,
    owner_user_id: true,
    workspace_id: true
});

const fromRow = (row: QuotaPauseRaw): QuotaPauseRow => ({
    quotaKey: row.quota_key,
    itemId: row.item_id,
    ownerUserId: Number(row.owner_user_id),
    workspaceId: Number(row.workspace_id)
});

export function quotaPausesRepo(pool: Q): QuotaPausesRepo {
    return {
        async all() {
            const r = await pool.query<QuotaPauseRaw>(`SELECT ${COLUMNS} FROM quota_pauses`);
            return r.rows.map(fromRow);
        },
        async ofOwnerKey(ownerUserId, quotaKey) {
            const r = await pool.query<QuotaPauseRaw>(
                `SELECT ${COLUMNS} FROM quota_pauses
                  WHERE owner_user_id = ? AND quota_key = ? FOR UPDATE`,
                [ownerUserId, quotaKey]
            );
            return r.rows.map(fromRow);
        },
        async upsert(rows) {
            if (rows.length === 0) return;
            await pool.query(
                `INSERT INTO quota_pauses (quota_key, item_id, owner_user_id, workspace_id) VALUES ?
                 ON DUPLICATE KEY UPDATE owner_user_id = VALUES(owner_user_id), workspace_id = VALUES(workspace_id)`,
                [rows.map((row) => [row.quotaKey, row.itemId, row.ownerUserId, row.workspaceId])]
            );
        },
        async remove(ownerUserId, quotaKey, itemIds) {
            if (itemIds.length === 0) return;
            await pool.query('DELETE FROM quota_pauses WHERE owner_user_id = ? AND quota_key = ? AND item_id IN (?)', [
                ownerUserId,
                quotaKey,
                itemIds
            ]);
        },
        async purgeKeysOtherThan(quotaKeys) {
            const r =
                quotaKeys.length === 0
                    ? await pool.query('DELETE FROM quota_pauses')
                    : await pool.query('DELETE FROM quota_pauses WHERE quota_key NOT IN (?)', [quotaKeys]);
            return r.rowCount;
        },
        async owners() {
            const r = await pool.query<{ owner_user_id: number }>('SELECT DISTINCT owner_user_id FROM quota_pauses');
            return r.rows.map((row) => Number(row.owner_user_id));
        },
        async setRecheck(ownerUserId, dueAt) {
            await pool.query(
                `INSERT INTO quota_rechecks (owner_user_id, due_at) VALUES (?, ?)
                 ON DUPLICATE KEY UPDATE due_at = VALUES(due_at)`,
                [ownerUserId, dueAt]
            );
        },
        async takeDueRechecks(now) {
            const r = await pool.query<{ owner_user_id: number }>(
                'SELECT owner_user_id FROM quota_rechecks WHERE due_at <= ?',
                [now]
            );
            const owners = r.rows.map((row) => Number(row.owner_user_id));
            if (owners.length > 0) {
                await pool.query('DELETE FROM quota_rechecks WHERE owner_user_id IN (?) AND due_at <= ?', [
                    owners,
                    now
                ]);
            }
            return owners;
        }
    };
}
