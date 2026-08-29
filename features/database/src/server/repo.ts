import type { DatabaseAlertRow, DatabaseRow } from '../contracts/domain';
import type { SdkQueryable } from '@deveye/types/sdk/server';

/** Une base et ses compteurs d'alertes ; le compte de projets vient du contrat de Projets. */
export interface DatabaseWithStatsRow extends DatabaseRow {
    alert_count: number;
    firing_count: number;
}

/**
 * Les bases de données de l'espace. Les deux secrets (mot de passe, secret du
 * tunnel) ont leurs propres colonnes et ne sortent que par la ligne brute.
 * La table s'appelle `database_connections` : `databases` est réservé par MySQL.
 */
export interface DatabaseRepo {
    list(workspaceId: number): Promise<DatabaseWithStatsRow[]>;
    /** Les siennes, plus celles qu'un autre espace y projette (`item_shares`). */
    listVisible(workspaceId: number): Promise<DatabaseWithStatsRow[]>;
    find(id: number, workspaceId: number): Promise<DatabaseRow | null>;
    /** Comme `find`, mais accepte aussi une base projetée vers cet espace. */
    findVisible(id: number, workspaceId: number): Promise<DatabaseRow | null>;
    findWithStats(id: number, workspaceId: number): Promise<DatabaseWithStatsRow | null>;
    /** Comme `findWithStats`, mais accepte aussi une base projetée vers cet espace. */
    findVisibleWithStats(id: number, workspaceId: number): Promise<DatabaseWithStatsRow | null>;
    /** L'unicité d'une base dans l'espace, ce que `content` chiffré ne peut porter. */
    findByName(workspaceId: number, nameRef: string): Promise<DatabaseRow | null>;
    count(workspaceId: number): Promise<number>;
    create(input: {
        workspaceId: number;
        engine: string;
        nameRef: string;
        content: string;
        secretEnc: string | null;
        accessContent: string | null;
        accessSecretEnc: string | null;
        monitorEnabled: boolean;
        intervalSeconds: number;
    }): Promise<DatabaseRow>;
    update(
        id: number,
        workspaceId: number,
        input: {
            nameRef: string;
            content: string;
            /** `undefined` = on garde le secret en place ; `null` = on l'efface. */
            secretEnc?: string | null;
            accessContent: string | null;
            accessSecretEnc?: string | null;
            monitorEnabled: boolean;
            intervalSeconds: number;
        }
    ): Promise<DatabaseRow | null>;
    remove(id: number, workspaceId: number): Promise<boolean>;
    reorder(workspaceId: number, ids: number[]): Promise<void>;
    recordCheck(
        id: number,
        input: {
            at: number;
            /** En ms ; écrite aussi sur un échec. */
            elapsedMs: number;
            status: 'up' | 'down';
            error: string | null;
            serverVersion: string | null;
            sizeBytes: number | null;
            tableCount: number | null;
        }
    ): Promise<void>;
    /** Les bases surveillées dont le relevé est dû, les plus en retard d'abord. */
    listDue(now: number, limit: number): Promise<DatabaseRow[]>;

    listAlerts(databaseId: number, workspaceId: number): Promise<DatabaseAlertRow[]>;
    /** Les alertes actives d'une base, pour le relevé périodique. */
    listEnabledAlerts(databaseId: number): Promise<DatabaseAlertRow[]>;
    findAlert(alertId: number, workspaceId: number): Promise<DatabaseAlertRow | null>;
    createAlert(input: {
        databaseId: number;
        workspaceId: number;
        enabled: boolean;
        combinator: string;
        content: string;
    }): Promise<DatabaseAlertRow>;
    updateAlert(
        alertId: number,
        workspaceId: number,
        input: { enabled: boolean; combinator: string; content: string }
    ): Promise<DatabaseAlertRow | null>;
    removeAlert(alertId: number, workspaceId: number): Promise<boolean>;
    /** `firedAt` n'est posé qu'à la transition. */
    recordAlertCheck(
        alertId: number,
        input: { at: number; firing: boolean; firedAt: number | null; error: string | null; content: string }
    ): Promise<void>;
}

export function createRepo(q: SdkQueryable): DatabaseRepo {
    // Des sous-requêtes plutôt que des jointures : combinées, celles-ci
    // multiplieraient les lignes avant de les regrouper.
    const SELECT_WITH_STATS = `
        SELECT d.*,
               (SELECT COUNT(*) FROM database_alerts a WHERE a.database_id = d.id) AS alert_count,
               (SELECT COUNT(*) FROM database_alerts a WHERE a.database_id = d.id AND a.firing = 1) AS firing_count
          FROM database_connections d`;

    const withNumbers = (row: DatabaseWithStatsRow): DatabaseWithStatsRow => ({
        ...row,
        alert_count: Number(row.alert_count),
        firing_count: Number(row.firing_count)
    });

    async function find(id: number, workspaceId: number): Promise<DatabaseRow | null> {
        const rows = await q.query<DatabaseRow>(
            'SELECT * FROM database_connections WHERE id = ? AND workspace_id = ?',
            [id, workspaceId]
        );
        return rows[0] ?? null;
    }

    async function findAlert(alertId: number, workspaceId: number): Promise<DatabaseAlertRow | null> {
        const rows = await q.query<DatabaseAlertRow>(
            'SELECT * FROM database_alerts WHERE id = ? AND workspace_id = ?',
            [alertId, workspaceId]
        );
        return rows[0] ?? null;
    }

    return {
        async list(workspaceId) {
            const rows = await q.query<DatabaseWithStatsRow>(
                `${SELECT_WITH_STATS} WHERE d.workspace_id = ? ORDER BY d.sort_order ASC, d.id ASC`,
                [workspaceId]
            );
            return rows.map(withNumbers);
        },
        async listVisible(workspaceId) {
            // `sort_order` appartient à l'espace d'origine : une base projetée
            // se range après les locales.
            const rows = await q.query<DatabaseWithStatsRow>(
                `${SELECT_WITH_STATS}
                  WHERE d.workspace_id = ?
                     OR EXISTS (SELECT 1 FROM item_shares sh
                                 WHERE sh.feature = 'database' AND sh.item_id = d.id
                                   AND sh.home_workspace_id = d.workspace_id
                                   AND sh.workspace_id = ?)
                  ORDER BY d.sort_order ASC, d.id ASC`,
                [workspaceId, workspaceId]
            );
            return rows.map(withNumbers);
        },
        find,
        async findVisible(id, workspaceId) {
            const rows = await q.query<DatabaseRow>(
                `SELECT * FROM database_connections d
                  WHERE d.id = ?
                    AND (d.workspace_id = ?
                         OR EXISTS (SELECT 1 FROM item_shares sh
                                     WHERE sh.feature = 'database' AND sh.item_id = d.id
                                       AND sh.home_workspace_id = d.workspace_id
                                       AND sh.workspace_id = ?))`,
                [id, workspaceId, workspaceId]
            );
            return rows[0] ?? null;
        },
        async findWithStats(id, workspaceId) {
            const rows = await q.query<DatabaseWithStatsRow>(
                `${SELECT_WITH_STATS} WHERE d.id = ? AND d.workspace_id = ?`,
                [id, workspaceId]
            );
            const row = rows[0];
            return row ? withNumbers(row) : null;
        },
        async findVisibleWithStats(id, workspaceId) {
            const rows = await q.query<DatabaseWithStatsRow>(
                `${SELECT_WITH_STATS}
                  WHERE d.id = ?
                    AND (d.workspace_id = ?
                         OR EXISTS (SELECT 1 FROM item_shares sh
                                     WHERE sh.feature = 'database' AND sh.item_id = d.id
                                       AND sh.home_workspace_id = d.workspace_id
                                       AND sh.workspace_id = ?))`,
                [id, workspaceId, workspaceId]
            );
            const row = rows[0];
            return row ? withNumbers(row) : null;
        },
        async findByName(workspaceId, nameRef) {
            const rows = await q.query<DatabaseRow>(
                'SELECT * FROM database_connections WHERE workspace_id = ? AND name_ref = ?',
                [workspaceId, nameRef]
            );
            return rows[0] ?? null;
        },
        async count(workspaceId) {
            const rows = await q.query<{ total: number }>(
                'SELECT COUNT(*) AS total FROM database_connections WHERE workspace_id = ?',
                [workspaceId]
            );
            return Number(rows[0]?.total ?? 0);
        },
        async create(input) {
            // Une nouvelle base atterrit à la fin de la liste.
            const posRows = await q.query<{ next: number }>(
                'SELECT COALESCE(MAX(sort_order) + 1, 0) AS next FROM database_connections WHERE workspace_id = ?',
                [input.workspaceId]
            );
            const res = await q.execute(
                `INSERT INTO database_connections
                     (workspace_id, engine, name_ref, sort_order, monitor_enabled, interval_seconds,
                      content, secret_enc, access_content, access_secret_enc)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    input.workspaceId,
                    input.engine,
                    input.nameRef,
                    Number(posRows[0]?.next ?? 0),
                    input.monitorEnabled ? 1 : 0,
                    input.intervalSeconds,
                    input.content,
                    input.secretEnc,
                    input.accessContent,
                    input.accessSecretEnc
                ]
            );
            const rows = await q.query<DatabaseRow>('SELECT * FROM database_connections WHERE id = ?', [res.insertId]);
            return rows[0];
        },
        async update(id, workspaceId, input) {
            // Un secret absent est conservé ; `null` explicite l'efface.
            const sets = [
                'name_ref = ?',
                'content = ?',
                'access_content = ?',
                'monitor_enabled = ?',
                'interval_seconds = ?'
            ];
            const params: unknown[] = [
                input.nameRef,
                input.content,
                input.accessContent,
                input.monitorEnabled ? 1 : 0,
                input.intervalSeconds
            ];
            if (input.secretEnc !== undefined) {
                sets.push('secret_enc = ?');
                params.push(input.secretEnc);
            }
            if (input.accessSecretEnc !== undefined) {
                sets.push('access_secret_enc = ?');
                params.push(input.accessSecretEnc);
            }
            params.push(id, workspaceId);
            const res = await q.execute(
                `UPDATE database_connections SET ${sets.join(', ')} WHERE id = ? AND workspace_id = ?`,
                params
            );
            if (res.affectedRows === 0) return null;
            return find(id, workspaceId);
        },
        async remove(id, workspaceId) {
            // Alertes et liaisons partent en CASCADE.
            const res = await q.execute('DELETE FROM database_connections WHERE id = ? AND workspace_id = ?', [
                id,
                workspaceId
            ]);
            return res.affectedRows > 0;
        },
        async reorder(workspaceId, ids) {
            for (let i = 0; i < ids.length; i++) {
                await q.execute('UPDATE database_connections SET sort_order = ? WHERE id = ? AND workspace_id = ?', [
                    i,
                    ids[i],
                    workspaceId
                ]);
            }
        },
        async recordCheck(id, input) {
            await q.execute(
                `UPDATE database_connections
                    SET last_check_at = ?, last_elapsed_ms = ?, status = ?, last_error = ?,
                        server_version = ?, size_bytes = ?, table_count = ?
                  WHERE id = ?`,
                [
                    input.at,
                    input.elapsedMs,
                    input.status,
                    input.error,
                    input.serverVersion,
                    input.sizeBytes,
                    input.tableCount,
                    id
                ]
            );
        },
        async listDue(now, limit) {
            // Jamais relevée d'abord (NULL trie en tête), puis la plus en retard.
            return q.query<DatabaseRow>(
                `SELECT * FROM database_connections
                  WHERE monitor_enabled = 1
                    AND (last_check_at IS NULL OR last_check_at + interval_seconds <= ?)
                  ORDER BY last_check_at IS NOT NULL, last_check_at ASC
                  LIMIT ?`,
                [now, limit]
            );
        },

        async listAlerts(databaseId, workspaceId) {
            return q.query<DatabaseAlertRow>(
                'SELECT * FROM database_alerts WHERE database_id = ? AND workspace_id = ? ORDER BY id ASC',
                [databaseId, workspaceId]
            );
        },
        async listEnabledAlerts(databaseId) {
            return q.query<DatabaseAlertRow>(
                'SELECT * FROM database_alerts WHERE database_id = ? AND enabled = 1 ORDER BY id ASC',
                [databaseId]
            );
        },
        findAlert,
        async createAlert(input) {
            const res = await q.execute(
                `INSERT INTO database_alerts (database_id, workspace_id, enabled, combinator, content)
                 VALUES (?, ?, ?, ?, ?)`,
                [input.databaseId, input.workspaceId, input.enabled ? 1 : 0, input.combinator, input.content]
            );
            const rows = await q.query<DatabaseAlertRow>('SELECT * FROM database_alerts WHERE id = ?', [res.insertId]);
            return rows[0];
        },
        async updateAlert(alertId, workspaceId, input) {
            const res = await q.execute(
                'UPDATE database_alerts SET enabled = ?, combinator = ?, content = ? WHERE id = ? AND workspace_id = ?',
                [input.enabled ? 1 : 0, input.combinator, input.content, alertId, workspaceId]
            );
            if (res.affectedRows === 0) return null;
            return findAlert(alertId, workspaceId);
        },
        async removeAlert(alertId, workspaceId) {
            const res = await q.execute('DELETE FROM database_alerts WHERE id = ? AND workspace_id = ?', [
                alertId,
                workspaceId
            ]);
            return res.affectedRows > 0;
        },
        async recordAlertCheck(alertId, input) {
            // `last_fired_at` n'est écrit qu'à la transition : c'est la date du
            // début du problème.
            const sets = ['last_check_at = ?', 'firing = ?', 'last_error = ?', 'content = ?'];
            const params: unknown[] = [input.at, input.firing ? 1 : 0, input.error, input.content];
            if (input.firedAt !== null) {
                sets.push('last_fired_at = ?');
                params.push(input.firedAt);
            }
            params.push(alertId);
            await q.execute(`UPDATE database_alerts SET ${sets.join(', ')} WHERE id = ?`, params);
        }
    };
}
