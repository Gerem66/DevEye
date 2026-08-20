import type { DatabaseAlertRow, DatabaseRow, ProjectDatabaseLinkRow } from 'deveye-types';
import type { Queryable } from '../pool';

type Q = Queryable;

/** Une base, plus ce que ses tables voisines en disent. */
export interface DatabaseWithStatsRow extends DatabaseRow {
    project_count: number;
    alert_count: number;
    firing_count: number;
}

/** Un projet lié à une base, tel que la jointure le rend. */
export interface DatabaseUsageRow {
    project_id: number;
    status: string;
    content: string;
}

/**
 * Les bases de données de l'espace.
 *
 * Deux secrets par ligne — le mot de passe de la base et celui du tunnel — dans
 * leurs propres colonnes, jamais dans `content`. Aucune méthode ici ne les rend
 * autrement qu'à travers la ligne brute, que seule la couche feature manipule ;
 * les DTO n'en portent qu'un booléen.
 *
 * ⚠️ La table s'appelle `database_connections` : `databases` est un mot réservé
 * de MySQL, et `CREATE TABLE databases` échoue à l'analyse (migration 068).
 */
export interface DatabaseRepo {
    list(workspaceId: number): Promise<DatabaseWithStatsRow[]>;
    /**
     * Les bases **visibles** depuis cet espace : les siennes, plus celles qu'un
     * autre espace y projette (`item_shares`).
     *
     * Séparé de `list` plutôt que de le remplacer : l'ordonnanceur de relevé
     * parcourt les bases d'un espace, pas ce qu'on y voit — relever deux fois la
     * même parce qu'elle est projetée ailleurs doublerait les connexions
     * sortantes et les alertes.
     */
    listVisible(workspaceId: number): Promise<DatabaseWithStatsRow[]>;
    find(id: number, workspaceId: number): Promise<DatabaseRow | null>;
    /** Comme `find`, mais accepte aussi une base projetée vers cet espace. */
    findVisible(id: number, workspaceId: number): Promise<DatabaseRow | null>;
    findWithStats(id: number, workspaceId: number): Promise<DatabaseWithStatsRow | null>;
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
    /** Le résultat d'un relevé : succès (erreur nulle) ou échec. */
    recordCheck(
        id: number,
        input: {
            at: number;
            /** Durée du relevé, en ms — écrite aussi quand il a échoué. */
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
    /** Les projets qui utilisent cette base — le titre reste à déchiffrer. */
    listUsage(databaseId: number, workspaceId: number): Promise<DatabaseUsageRow[]>;

    // -- liaison projet → base --------------------------------------------
    listLinkedIds(projectId: number, workspaceId: number): Promise<number[]>;
    link(projectId: number, workspaceId: number, databaseId: number): Promise<void>;
    unlink(projectId: number, workspaceId: number, databaseId: number): Promise<boolean>;
    unlinkAll(projectId: number, workspaceId: number): Promise<void>;
    findLink(projectId: number, workspaceId: number, databaseId: number): Promise<ProjectDatabaseLinkRow | null>;

    // -- alertes -----------------------------------------------------------
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
    /** L'issue d'une évaluation ; `firedAt` n'est posé qu'à la transition. */
    recordAlertCheck(
        alertId: number,
        input: { at: number; firing: boolean; firedAt: number | null; error: string | null; content: string }
    ): Promise<void>;
}

export function databaseRepo(pool: Q): DatabaseRepo {
    /**
     * Le tronc commun des lectures enrichies.
     *
     * Trois sous-requêtes plutôt que trois jointures : chacune agrège sur une
     * table différente, et les combiner en jointures multiplierait les lignes
     * avant de les regrouper — un compte de projets faussé par le nombre
     * d'alertes est exactement le genre de chiffre faux qui ne se voit pas.
     */
    const SELECT_WITH_STATS = `
        SELECT d.*,
               (SELECT COUNT(*) FROM project_database_links l WHERE l.database_id = d.id) AS project_count,
               (SELECT COUNT(*) FROM database_alerts a WHERE a.database_id = d.id) AS alert_count,
               (SELECT COUNT(*) FROM database_alerts a WHERE a.database_id = d.id AND a.firing = 1) AS firing_count
          FROM database_connections d`;

    const withNumbers = (row: DatabaseWithStatsRow): DatabaseWithStatsRow => ({
        ...row,
        project_count: Number(row.project_count),
        alert_count: Number(row.alert_count),
        firing_count: Number(row.firing_count)
    });

    return {
        async list(workspaceId) {
            const r = await pool.query<DatabaseWithStatsRow>(
                `${SELECT_WITH_STATS} WHERE d.workspace_id = ? ORDER BY d.sort_order ASC, d.id ASC`,
                [workspaceId]
            );
            return r.rows.map(withNumbers);
        },
        async listVisible(workspaceId) {
            // `sort_order` appartient à l'espace d'origine : une base projetée
            // se range donc après les locales. Lui donner un ordre propre à
            // chaque espace demanderait une colonne par projection.
            const r = await pool.query<DatabaseWithStatsRow>(
                `${SELECT_WITH_STATS}
                  WHERE d.workspace_id = ?
                     OR EXISTS (SELECT 1 FROM item_shares sh
                                 WHERE sh.feature = 'database' AND sh.item_id = d.id
                                   AND sh.home_workspace_id = d.workspace_id
                                   AND sh.workspace_id = ?)
                  ORDER BY d.sort_order ASC, d.id ASC`,
                [workspaceId, workspaceId]
            );
            return r.rows.map(withNumbers);
        },
        async find(id, workspaceId) {
            const r = await pool.query<DatabaseRow>(
                'SELECT * FROM database_connections WHERE id = ? AND workspace_id = ?',
                [id, workspaceId]
            );
            return r.rows[0] ?? null;
        },
        async findVisible(id, workspaceId) {
            const r = await pool.query<DatabaseRow>(
                `SELECT * FROM database_connections d
                  WHERE d.id = ?
                    AND (d.workspace_id = ?
                         OR EXISTS (SELECT 1 FROM item_shares sh
                                     WHERE sh.feature = 'database' AND sh.item_id = d.id
                                       AND sh.home_workspace_id = d.workspace_id
                                       AND sh.workspace_id = ?))`,
                [id, workspaceId, workspaceId]
            );
            return r.rows[0] ?? null;
        },
        async findWithStats(id, workspaceId) {
            const r = await pool.query<DatabaseWithStatsRow>(
                `${SELECT_WITH_STATS} WHERE d.id = ? AND d.workspace_id = ?`,
                [id, workspaceId]
            );
            const row = r.rows[0];
            return row ? withNumbers(row) : null;
        },
        async findByName(workspaceId, nameRef) {
            const r = await pool.query<DatabaseRow>(
                'SELECT * FROM database_connections WHERE workspace_id = ? AND name_ref = ?',
                [workspaceId, nameRef]
            );
            return r.rows[0] ?? null;
        },
        async count(workspaceId) {
            const r = await pool.query<{ total: number }>(
                'SELECT COUNT(*) AS total FROM database_connections WHERE workspace_id = ?',
                [workspaceId]
            );
            return Number(r.rows[0]?.total ?? 0);
        },
        async create(input) {
            // Une nouvelle base atterrit à la fin de la liste, jamais au milieu.
            const posRow = await pool.query<{ next: number }>(
                'SELECT COALESCE(MAX(sort_order) + 1, 0) AS next FROM database_connections WHERE workspace_id = ?',
                [input.workspaceId]
            );
            const res = await pool.query(
                `INSERT INTO database_connections
                     (workspace_id, engine, name_ref, sort_order, monitor_enabled, interval_seconds,
                      content, secret_enc, access_content, access_secret_enc)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    input.workspaceId,
                    input.engine,
                    input.nameRef,
                    Number(posRow.rows[0]?.next ?? 0),
                    input.monitorEnabled ? 1 : 0,
                    input.intervalSeconds,
                    input.content,
                    input.secretEnc,
                    input.accessContent,
                    input.accessSecretEnc
                ]
            );
            const r = await pool.query<DatabaseRow>('SELECT * FROM database_connections WHERE id = ?', [res.insertId]);
            return r.rows[0];
        },
        async update(id, workspaceId, input) {
            // Un secret absent est **conservé** : le client ne le reçoit jamais,
            // il ne peut donc pas le renvoyer inchangé. `null` explicite l'efface.
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
            const res = await pool.query(
                `UPDATE database_connections SET ${sets.join(', ')} WHERE id = ? AND workspace_id = ?`,
                params
            );
            if (res.rowCount === 0) return null;
            return this.find(id, workspaceId);
        },
        async remove(id, workspaceId) {
            // Alertes et liaisons partent en CASCADE ; les projets liés, eux, ne
            // perdent qu'un pointeur.
            const r = await pool.query('DELETE FROM database_connections WHERE id = ? AND workspace_id = ?', [
                id,
                workspaceId
            ]);
            return r.rowCount > 0;
        },
        async reorder(workspaceId, ids) {
            for (let i = 0; i < ids.length; i++) {
                await pool.query('UPDATE database_connections SET sort_order = ? WHERE id = ? AND workspace_id = ?', [
                    i,
                    ids[i],
                    workspaceId
                ]);
            }
        },
        async recordCheck(id, input) {
            await pool.query(
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
            // Une base non surveillée n'entre jamais ici : c'est ce qui fait que
            // « à la demande » est bien le comportement par défaut.
            const r = await pool.query<DatabaseRow>(
                `SELECT * FROM database_connections
                  WHERE monitor_enabled = 1
                    AND (last_check_at IS NULL OR last_check_at + interval_seconds <= ?)
                  ORDER BY last_check_at IS NOT NULL, last_check_at ASC
                  LIMIT ?`,
                [now, limit]
            );
            return r.rows;
        },
        async listUsage(databaseId, workspaceId) {
            // Les projets confidentiels ne peuvent pas être liés : filtrer sur
            // l'étage ouvert garantit que tous les titres rendus ici sont
            // lisibles sans session, plutôt que d'en masquer certains.
            const r = await pool.query<DatabaseUsageRow>(
                `SELECT p.id AS project_id, p.status, p.content
                   FROM project_database_links l
                   JOIN projects p ON p.id = l.project_id
                  WHERE l.database_id = ? AND l.workspace_id = ? AND p.security_tier = 'open'
                  ORDER BY p.sort_order ASC, p.id ASC`,
                [databaseId, workspaceId]
            );
            return r.rows;
        },

        async listLinkedIds(projectId, workspaceId) {
            const r = await pool.query<{ database_id: number }>(
                `SELECT l.database_id
                   FROM project_database_links l
                   JOIN database_connections d ON d.id = l.database_id
                  WHERE l.project_id = ? AND l.workspace_id = ?
                  ORDER BY d.sort_order ASC, d.id ASC`,
                [projectId, workspaceId]
            );
            return r.rows.map((row) => Number(row.database_id));
        },
        async link(projectId, workspaceId, databaseId) {
            await pool.query(
                'INSERT IGNORE INTO project_database_links (project_id, database_id, workspace_id) VALUES (?, ?, ?)',
                [projectId, databaseId, workspaceId]
            );
        },
        async unlink(projectId, workspaceId, databaseId) {
            const r = await pool.query(
                'DELETE FROM project_database_links WHERE project_id = ? AND database_id = ? AND workspace_id = ?',
                [projectId, databaseId, workspaceId]
            );
            return r.rowCount > 0;
        },
        async unlinkAll(projectId, workspaceId) {
            await pool.query('DELETE FROM project_database_links WHERE project_id = ? AND workspace_id = ?', [
                projectId,
                workspaceId
            ]);
        },
        async findLink(projectId, workspaceId, databaseId) {
            const r = await pool.query<ProjectDatabaseLinkRow>(
                'SELECT * FROM project_database_links WHERE project_id = ? AND database_id = ? AND workspace_id = ?',
                [projectId, databaseId, workspaceId]
            );
            return r.rows[0] ?? null;
        },

        async listAlerts(databaseId, workspaceId) {
            const r = await pool.query<DatabaseAlertRow>(
                'SELECT * FROM database_alerts WHERE database_id = ? AND workspace_id = ? ORDER BY id ASC',
                [databaseId, workspaceId]
            );
            return r.rows;
        },
        async listEnabledAlerts(databaseId) {
            const r = await pool.query<DatabaseAlertRow>(
                'SELECT * FROM database_alerts WHERE database_id = ? AND enabled = 1 ORDER BY id ASC',
                [databaseId]
            );
            return r.rows;
        },
        async findAlert(alertId, workspaceId) {
            const r = await pool.query<DatabaseAlertRow>(
                'SELECT * FROM database_alerts WHERE id = ? AND workspace_id = ?',
                [alertId, workspaceId]
            );
            return r.rows[0] ?? null;
        },
        async createAlert(input) {
            const res = await pool.query(
                `INSERT INTO database_alerts (database_id, workspace_id, enabled, combinator, content)
                 VALUES (?, ?, ?, ?, ?)`,
                [input.databaseId, input.workspaceId, input.enabled ? 1 : 0, input.combinator, input.content]
            );
            const r = await pool.query<DatabaseAlertRow>('SELECT * FROM database_alerts WHERE id = ?', [res.insertId]);
            return r.rows[0];
        },
        async updateAlert(alertId, workspaceId, input) {
            const res = await pool.query(
                'UPDATE database_alerts SET enabled = ?, combinator = ?, content = ? WHERE id = ? AND workspace_id = ?',
                [input.enabled ? 1 : 0, input.combinator, input.content, alertId, workspaceId]
            );
            if (res.rowCount === 0) return null;
            return this.findAlert(alertId, workspaceId);
        },
        async removeAlert(alertId, workspaceId) {
            const r = await pool.query('DELETE FROM database_alerts WHERE id = ? AND workspace_id = ?', [
                alertId,
                workspaceId
            ]);
            return r.rowCount > 0;
        },
        async recordAlertCheck(alertId, input) {
            // `last_fired_at` n'est écrit qu'à la transition : le laisser
            // s'écraser à chaque relevé effacerait la seule date qui dise quand
            // le problème a commencé.
            const sets = ['last_check_at = ?', 'firing = ?', 'last_error = ?', 'content = ?'];
            const params: unknown[] = [input.at, input.firing ? 1 : 0, input.error, input.content];
            if (input.firedAt !== null) {
                sets.push('last_fired_at = ?');
                params.push(input.firedAt);
            }
            params.push(alertId);
            await pool.query(`UPDATE database_alerts SET ${sets.join(', ')} WHERE id = ?`, params);
        }
    };
}
